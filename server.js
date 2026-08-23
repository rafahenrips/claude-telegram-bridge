import express from "express";
import crypto from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";

const app = express();
app.set("trust proxy", 1); // Render fica atrás de proxy; sem isso req.protocol vira "http" e quebra o OAuth do Lovable
app.use(express.json());

const LOVABLE_WORKSPACE_ID = "aD4lGjRXiZsXfyXexOBi"; // Rafael's Lovable — NUNCA outro workspace, especialmente nunca OmniaConexa
const LOVABLE_MCP_URL = "https://mcp.lovable.dev";
const OAUTH_CALLBACK_PATH = "/oauth/lovable/callback";

// Render API — usado só pra persistir os tokens do Lovable como env vars, assim eles
// sobrevivem a redeploys e ao spin-down do plano free. Sem RENDER_API_KEY isso vira no-op
// e os tokens ficam só em memória (perdidos no próximo deploy/restart).
const RENDER_API_KEY = process.env.RENDER_API_KEY || "";
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID || "srv-da5itvgu01pc73fdqvm0";

const ORCHESTRATOR_PROMPT = `Você é o Orquestrador do pipeline de criação/alteração de sistemas do Rafael. Você é tech lead + PO: não escreve código nem mexe no Lovable diretamente. As ferramentas mcp__lovable__* não estão disponíveis pra você — nunca tente usá-las.

Fluxo:
1. Ao receber um pedido, confirme o entendimento em 1-2 frases, de forma objetiva e técnica. Pergunte apenas o essencial que faltar (nome do sistema, funcionalidades-chave). Não prossiga até o pedido estar claro o suficiente.
2. Quando estiver claro, acione o subagente "analyst" (ferramenta Task) pra transformar o pedido numa especificação técnica com critérios de aceite.
3. Acione o subagente "dev" (Task) passando a especificação, pra criar ou alterar o projeto no Lovable.
4. Acione o subagente "qa" (Task) passando os critérios de aceite e o que o dev retornou, pra validar o resultado.
5. Se o QA reprovar, acione o dev de novo com os apontamentos e repita a validação. Se aprovar, siga pro passo 6.
6. Responda ao Rafael com o link de preview e um resumo curto (1-2 frases) do que foi construído.

Se o pedido não for sobre construir/alterar um sistema (por exemplo, uma pergunta comum), responda direto, sem acionar subagentes.
Nunca use listas, markdown pesado ou emojis — é uma conversa de chat comum.`;

const ANALYST_PROMPT = `Você é o Analista/Spec Writer do pipeline do Rafael. Recebe um pedido já confirmado pelo orquestrador e escreve uma especificação técnica objetiva: requisitos funcionais, principais telas/fluxos, e uma lista curta e clara de critérios de aceite (Definition of Done). Você não tem acesso a nenhuma ferramenta externa — devolva só a especificação em texto estruturado pro orquestrador repassar ao dev.`;

const DEV_PROMPT = `Você é o Dev do pipeline do Rafael. Recebe uma especificação técnica e é o único agente com acesso de escrita ao Lovable. Use sempre workspace_id "${LOVABLE_WORKSPACE_ID}" — NUNCA use nenhum outro workspace, especialmente nunca o da OmniaConexa.

Se ainda não existe projeto pra essa tarefa, crie com create_project e uma mensagem inicial detalhada baseada na especificação. Se já existe um projeto (o orquestrador vai indicar o project_id), use send_message pra aplicar as mudanças pedidas. Acompanhe com get_message/get_project até ter um preview_url pronto. Devolva ao orquestrador: preview_url, editor_url, project_id e um resumo curto do que foi implementado.`;

const QA_PROMPT = `Você é o QA/Revisor do pipeline do Rafael. Recebe os critérios de aceite e o resultado que o dev produziu no Lovable. Você só tem ferramentas de leitura no Lovable (get_project, get_message, list_projects) — nunca de escrita. Inspecione o projeto e compare com os critérios de aceite.

Responda com um veredito objetivo começando por APROVADO ou REPROVADO. Se reprovado, liste de forma curta e específica o que precisa ser corrigido para o orquestrador acionar o dev de novo.`;

function loadProjects() {
  try {
    return JSON.parse(process.env.PROJECTS_CONFIG || "[]");
  } catch {
    return null;
  }
}

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const oauthState = new Map();
// sessão do Claude por chat do Telegram, pra manter contexto entre mensagens (resume)
const chatSessions = new Map();

let lovableAuth = process.env.LOVABLE_ACCESS_TOKEN
  ? {
      accessToken: process.env.LOVABLE_ACCESS_TOKEN,
      refreshToken: process.env.LOVABLE_REFRESH_TOKEN,
      tokenEndpoint: null,
      expiresAt: null, // desconhecido; só vamos descobrir no próximo refresh
    }
  : null;

async function persistLovableTokens() {
  if (!RENDER_API_KEY || !lovableAuth?.accessToken) return;
  try {
    const resp = await fetch(
      `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${RENDER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([
          { key: "LOVABLE_ACCESS_TOKEN", value: lovableAuth.accessToken },
          { key: "LOVABLE_REFRESH_TOKEN", value: lovableAuth.refreshToken || "" },
        ]),
      }
    );
    if (!resp.ok) {
      console.error("[lovable] falha ao persistir tokens no Render:", resp.status, await resp.text());
    } else {
      console.log("[lovable] tokens persistidos no Render.");
    }
  } catch (err) {
    console.error("[lovable] erro ao persistir tokens no Render:", err);
  }
}

async function discoverOAuthEndpoints() {
  const prmResp = await fetch(`${LOVABLE_MCP_URL}/.well-known/oauth-protected-resource`);
  if (!prmResp.ok) throw new Error(`protected-resource metadata: ${prmResp.status}`);
  const prm = await prmResp.json();
  const authServer = (prm.authorization_servers && prm.authorization_servers[0]) || LOVABLE_MCP_URL;

  const asMetaResp = await fetch(`${authServer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`);
  if (!asMetaResp.ok) throw new Error(`authorization-server metadata: ${asMetaResp.status}`);
  const asMeta = await asMetaResp.json();

  return {
    authorizationEndpoint: asMeta.authorization_endpoint,
    tokenEndpoint: asMeta.token_endpoint,
    registrationEndpoint: asMeta.registration_endpoint,
  };
}

function clientMetadataUrl(req) {
  return `${req.protocol}://${req.get("host")}/oauth/lovable/client-metadata.json`;
}

app.get("/oauth/lovable/client-metadata.json", (req, res) => {
  const redirectUri = `${req.protocol}://${req.get("host")}${OAUTH_CALLBACK_PATH}`;
  const clientId = clientMetadataUrl(req);
  res.json({
    client_id: clientId,
    client_name: "claude-telegram-bridge",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
  });
});

app.get("/oauth/lovable/start", async (req, res) => {
  try {
    const { authorizationEndpoint, tokenEndpoint } = await discoverOAuthEndpoints();
    const redirectUri = `${req.protocol}://${req.get("host")}${OAUTH_CALLBACK_PATH}`;
    const clientId = clientMetadataUrl(req);

    const codeVerifier = base64url(crypto.randomBytes(32));
    const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
    const state = base64url(crypto.randomBytes(16));

    oauthState.set(state, { codeVerifier, tokenEndpoint, clientId, redirectUri });

    const authUrl = new URL(authorizationEndpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);

    res.redirect(authUrl.toString());
  } catch (err) {
    console.error("[oauth start]", err);
    res.status(500).send(`Erro ao iniciar login com o Lovable: ${err.message}`);
  }
});

app.get(OAUTH_CALLBACK_PATH, async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`Lovable recusou a autorização: ${error}`);
  }

  const saved = oauthState.get(state);
  if (!saved) {
    return res.status(400).send("Estado inválido ou expirado. Tenta iniciar o login de novo em /oauth/lovable/start.");
  }
  oauthState.delete(state);

  try {
    const tokenResp = await fetch(saved.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: saved.redirectUri,
        client_id: saved.clientId,
        code_verifier: saved.codeVerifier,
      }),
    });

    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      throw new Error(`token exchange failed: ${tokenResp.status} ${errText}`);
    }

    const tokens = await tokenResp.json();
    lovableAuth = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenEndpoint: saved.tokenEndpoint,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
    };

    console.log("[oauth] tokens obtidos, expira em", tokens.expires_in, "s");
    await persistLovableTokens();

    res.send("Login com o Lovable concluído. Pode fechar esta aba e voltar pro Telegram.");
  } catch (err) {
    console.error("[oauth callback]", err);
    res.status(500).send(`Erro ao concluir login: ${err.message}`);
  }
});

async function refreshLovableTokenIfNeeded() {
  if (!lovableAuth?.refreshToken) return;

  // se não sabemos quando expira (ex: veio de env var no boot), só espera dar 401 e tenta então
  if (lovableAuth.expiresAt && Date.now() < lovableAuth.expiresAt - 60_000) return;

  try {
    const { tokenEndpoint } = lovableAuth.tokenEndpoint
      ? { tokenEndpoint: lovableAuth.tokenEndpoint }
      : await discoverOAuthEndpoints();

    const resp = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: lovableAuth.refreshToken,
      }),
    });

    if (!resp.ok) {
      console.error("[lovable] refresh falhou:", resp.status, await resp.text());
      return;
    }

    const tokens = await resp.json();
    lovableAuth = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || lovableAuth.refreshToken,
      tokenEndpoint,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
    };
    console.log("[lovable] token renovado.");
    await persistLovableTokens();
  } catch (err) {
    console.error("[lovable] erro ao renovar token:", err);
  }
}

function buildAgents(mcpServers) {
  const hasLovable = !!mcpServers.lovable;

  return {
    analyst: {
      description: "Escreve a especificação técnica e os critérios de aceite a partir de um pedido já confirmado.",
      prompt: ANALYST_PROMPT,
      tools: [],
    },
    dev: {
      description: "Único agente com acesso de escrita ao Lovable; cria/altera o projeto a partir da especificação.",
      prompt: DEV_PROMPT,
      tools: hasLovable
        ? [
            "mcp__lovable__create_project",
            "mcp__lovable__send_message",
            "mcp__lovable__get_message",
            "mcp__lovable__get_project",
            "mcp__lovable__list_projects",
            "mcp__lovable__list_workspaces",
          ]
        : [],
      mcpServers: hasLovable ? ["lovable"] : undefined,
    },
    qa: {
      description: "Revisa o que o dev construiu no Lovable contra os critérios de aceite; só lê, nunca escreve.",
      prompt: QA_PROMPT,
      tools: hasLovable
        ? ["mcp__lovable__get_project", "mcp__lovable__get_message", "mcp__lovable__list_projects"]
        : [],
      mcpServers: hasLovable ? ["lovable"] : undefined,
    },
  };
}

async function askClaude({ systemPrompt, userText, sessionKey }) {
  let finalText = "";

  await refreshLovableTokenIfNeeded();

  const mcpServers = {};
  if (lovableAuth?.accessToken) {
    mcpServers.lovable = {
      type: "http",
      url: LOVABLE_MCP_URL,
      headers: { Authorization: `Bearer ${lovableAuth.accessToken}` },
    };
  }

  const resumeSessionId = chatSessions.get(sessionKey);

  for await (const message of query({
    prompt: userText,
    options: {
      systemPrompt: systemPrompt || ORCHESTRATOR_PROMPT,
      mcpServers,
      disallowedTools: ["mcp__lovable__*"],
      agents: buildAgents(mcpServers),
      permissionMode: "bypassPermissions",
      resume: resumeSessionId,
    },
  })) {
    if (message.type === "system" && message.subtype === "init") {
      console.log("[mcp status]", JSON.stringify(message.mcp_servers || message.mcpServers || {}));
      if (message.session_id) chatSessions.set(sessionKey, message.session_id);
    }
    // parent_tool_use_id != null significa que a mensagem veio de dentro de um subagente
    // (analyst/dev/qa) — só queremos o texto que o orquestrador realmente devolve pro Rafael.
    if (message.type === "assistant" && !message.parent_tool_use_id && message.message?.content) {
      for (const block of message.message.content) {
        if ("text" in block) {
          finalText += block.text;
        }
      }
    }
  }

  return finalText || "Não consegui gerar uma resposta agora. Tenta reformular o pedido?";
}

const TELEGRAM_MAX_LENGTH = 4096;

function splitForTelegram(text) {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > TELEGRAM_MAX_LENGTH) {
    let cut = rest.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
    if (cut <= 0) cut = TELEGRAM_MAX_LENGTH;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendTelegramMessage({ botToken, chatId, text }) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  let lastResult;
  for (const chunk of splitForTelegram(text)) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Telegram error ${resp.status}: ${errText}`);
    }
    lastResult = await resp.json();
  }
  return lastResult;
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "claude-telegram-bridge", lovableAuthorized: !!lovableAuth?.accessToken });
});

// DEBUG TEMPORÁRIO — remover depois de confirmar se o RemoteTrigger existe nesta sessão do SDK
app.get("/debug/probe-tools", async (req, res) => {
  let finalText = "";
  try {
    for await (const message of query({
      prompt: "Liste, em texto puro sem markdown, TODOS os nomes de ferramentas que você tem disponíveis agora (incluindo MCP tools e ferramentas internas tipo RemoteTrigger, CronCreate, ScheduleWakeup, se existirem). Não execute nenhuma delas, só liste os nomes exatos. Se RemoteTrigger não existir, diga explicitamente 'RemoteTrigger NAO disponivel'.",
      options: { permissionMode: "bypassPermissions", maxTurns: 3 },
    })) {
      if (message.type === "assistant" && !message.parent_tool_use_id && message.message?.content) {
        for (const block of message.message.content) {
          if ("text" in block) finalText += block.text;
        }
      }
    }
    res.type("text/plain").send(finalText || "(vazio)");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.get("/telegram/:slug", (req, res) => {
  res.json({ ok: true, message: `Ponte Claude ativa para o projeto "${req.params.slug}".` });
});

app.post("/telegram/:slug", async (req, res) => {
  const { slug } = req.params;

  const projects = loadProjects();
  if (projects === null) {
    return res.status(500).json({ error: "PROJECTS_CONFIG inválido (JSON malformado)" });
  }

  const project = projects.find((p) => p.slug === slug);
  if (!project) {
    return res.status(404).json({ error: `Projeto "${slug}" não configurado em PROJECTS_CONFIG` });
  }

  const incomingSecret = req.headers["x-telegram-bot-api-secret-token"];
  if (project.webhookSecret && incomingSecret !== project.webhookSecret) {
    return res.status(401).json({ error: "secret_token inválido" });
  }

  const update = req.body;
  const message = update?.message;

  if (!message || !message.text) {
    return res.status(200).json({ ok: true });
  }

  const chatId = message.chat.id;
  const userText = message.text;

  res.status(200).json({ ok: true });

  try {
    const reply = await askClaude({
      systemPrompt: project.systemPrompt,
      userText,
      sessionKey: `${slug}:${chatId}`,
    });
    await sendTelegramMessage({ botToken: project.botToken, chatId, text: reply });
  } catch (err) {
    console.error(`[${slug}]`, err);
    await sendTelegramMessage({
      botToken: project.botToken,
      chatId,
      text: "Deu erro ao processar seu pedido agora. Tenta de novo em instantes.",
    }).catch(() => {});
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`claude-telegram-bridge ouvindo na porta ${port}`);
});
