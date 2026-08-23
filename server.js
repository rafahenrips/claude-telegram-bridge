import express from "express";
import { query } from "@anthropic-ai/claude-agent-sdk";

const app = express();
app.use(express.json());

const LOVABLE_WORKSPACE_ID = "aD4lGjRXiZsXfyXexOBi"; // Rafael's Lovable — NUNCA outro workspace, especialmente nunca OmniaConexa

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

async function askClaude({ systemPrompt, userText }) {
  let finalText = "";

  for await (const message of query({
    prompt: userText,
    options: {
      systemPrompt: systemPrompt || DEFAULT_SYSTEM_PROMPT,
      mcpServers: {
        lovable: {
          type: "http",
          url: "https://mcp.lovable.dev",
        },
      },
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
  res.json({ ok: true, service: "claude-telegram-bridge" });
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
