import express from "express";
import crypto from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";

const app = express();
app.set("trust proxy", 1); // Render fica atrás de proxy; sem isso req.protocol vira "http" e quebra o OAuth do Lovable
app.use(express.json());

const LOVABLE_WORKSPACE_ID = "aD4lGjRXiZsXfyXexOBi"; // Rafael's Lovable — NUNCA outro workspace, especialmente nunca OmniaConexa
const LOVABLE_MCP_URL = "https://mcp.lovable.dev";
const OAUTH_CALLBACK_PATH = "/oauth/lovable/callback";

const DEFAULT_SYSTEM_PROMPT = `Você é o orquestrador do pipeline de criação/alteração de sistemas do Rafael, com acesso direto ao Lovable via MCP.

Quando o Rafael pedir a criação ou alteração de um sistema:
1. Confirme o que entendeu em 1-2 frases, de forma objetiva e técnica. Pergunte apenas o essencial que faltar (nome do sistema, funcionalidades-chave), sem enrolação.
2. Assim que o pedido estiver claro o suficiente, use a ferramenta do Lovable para criar o projeto (create_project), sempre com workspace_id "${LOVABLE_WORKSPACE_ID}" — NUNCA use nenhum outro workspace, especialmente nunca o da OmniaConexa. Escreva uma mensagem inicial detalhada pro Lovable, descrevendo requisitos claros a partir do pedido do Rafael.
3. Acompanhe a conclusão do projeto (get_message / get_project) até ter um preview_url pronto.
4. Responda ao Rafael com o link de preview e um resumo curto (1-2 frases) do que foi construído.

Se o pedido não for sobre construir/alterar um sistema (por exemplo, uma pergunta comum), apenas responda normalmente, sem acionar o Lovable.
Nunca use listas, markdown pesado ou emojis — é uma conversa de chat comum.`;

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
let lovableAuth = process.env.LOVABLE_ACCESS_TOKEN
  ? { accessToken: process.env.LOVABLE_ACCESS_TOKEN, refreshToken: process.env.LOVABLE_REFRESH_TOKEN }
  : null;

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

async function registerClient(registrationEndpoint, redirectUri) {
  const resp = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "claude-telegram-bridge",
    }),
  });
  if (!resp.ok) throw new Error(`dynamic client registration failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.client_id;
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
    lovableAuth = { accessToken: tokens.access_token, refreshToken: tokens.refresh_token };

    console.log("[oauth] tokens obtidos:", JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
    }));

    res.send("Login com o Lovable concluído. Pode fechar esta aba e voltar pro Telegram.");
  } catch (err) {
    console.error("[oauth callback]", err);
    res.status(500).send(`Erro ao concluir login: ${err.message}`);
  }
});

async function askClaude({ systemPrompt, userText }) {
  let finalText = "";

  const mcpServers = {};
  if (lovableAuth?.accessToken) {
    mcpServers.lovable = {
      type: "http",
      url: LOVABLE_MCP_URL,
      headers: { Authorization: `Bearer ${lovableAuth.accessToken}` },
    };
  }

  for await (const message of query({
    prompt: userText,
    options: {
      systemPrompt: systemPrompt || DEFAULT_SYSTEM_PROMPT,
      mcpServers,
      allowedTools: [
        "mcp__lovable__create_project",
        "mcp__lovable__send_message",
        "mcp__lovable__get_message",
        "mcp__lovable__get_project",
        "mcp__lovable__list_projects",
        "mcp__lovable__list_workspaces",
      ],
      permissionMode: "bypassPermissions",
    },
  })) {
    if (message.type === "system" && message.subtype === "init") {
      console.log("[mcp status]", JSON.stringify(message.mcp_servers || message.mcpServers || {}));
    }
    if (message.type === "assistant" && message.message?.content) {
      for (const block of message.message.content) {
        if ("text" in block) {
          finalText += block.text;
        }
      }
    }
  }

  return finalText || "Não consegui gerar uma resposta agora. Tenta reformular o pedido?";
}

async function sendTelegramMessage({ botToken, chatId, text }) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Telegram error ${resp.status}: ${errText}`);
  }
  return resp.json();
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "claude-telegram-bridge", lovableAuthorized: !!lovableAuth?.accessToken });
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
    const reply = await askClaude({ systemPrompt: project.systemPrompt, userText });
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
