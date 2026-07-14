const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Cache-Control, Pragma",
  "Access-Control-Max-Age": "86400",
};

const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase();
  return (
    BLOCKED_HOSTS.has(host) ||
    host.endsWith(".local") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}

function decodeHtml(value = "") {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function getAttr(tag, attr) {
  const pattern = new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, "i");
  return tag.match(pattern)?.[1] || "";
}

function findMeta(html, keys) {
  const tags = html.match(/<meta\s+[^>]*>/gi) || [];
  for (const tag of tags) {
    const property = getAttr(tag, "property").toLowerCase();
    const name = getAttr(tag, "name").toLowerCase();
    if (keys.includes(property) || keys.includes(name)) {
      const content = getAttr(tag, "content");
      if (content) return decodeHtml(content);
    }
  }
  return "";
}

function findTitle(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
  return decodeHtml(title.replace(/\s+/g, " "));
}

function stripHtml(value = "") {
  return decodeHtml(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
  );
}

function findNextDataArticleText(html) {
  const nextData = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!nextData) return "";

  try {
    const data = JSON.parse(nextData);
    const article = data?.props?.pageProps?.article;
    const bodyHtml = article?.bodyHtml || article?.body || article?.content || "";
    return stripHtml(bodyHtml);
  } catch {
    return "";
  }
}

function findArticleText(html) {
  const nextDataText = findNextDataArticleText(html);
  if (nextDataText.length > 120) return nextDataText.slice(0, 3000);

  const candidates = [
    ...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi),
    ...html.matchAll(/<main\b[^>]*>([\s\S]*?)<\/main>/gi),
    ...html.matchAll(/<div\b[^>]*(?:class|id)=["'][^"']*(?:article|entry|post|content|note|body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi),
  ]
    .map(match => stripHtml(match[1]))
    .filter(text => text.length > 120)
    .sort((a, b) => b.length - a.length);

  const text = candidates[0] || stripHtml(html);
  return text
    .replace(/関連記事|シェア|ログイン|新規登録|コメント|広告/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);
}

function absoluteUrl(value, baseUrl) {
  if (!value) return "";
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return "";
  }
}

function getAiResponseText(result) {
  if (!result) return "";
  const readContent = content => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map(part => part.text || part.content || "").filter(Boolean).join(" ");
    }
    return "";
  };

  if (typeof result.output_text === "string") return result.output_text;
  if (typeof result.response === "string") return result.response;
  if (typeof result.text === "string") return result.text;
  if (typeof result.result?.response === "string") return result.result.response;
  if (typeof result.result?.text === "string") return result.result.text;
  if (result.message?.content) return readContent(result.message.content);
  if (result.result?.message?.content) return readContent(result.result.message.content);
  if (Array.isArray(result.output)) {
    return result.output
      .flatMap(item => item.content || [])
      .map(content => content.text || (content.type === "output_text" ? content.text : ""))
      .filter(Boolean)
      .join(" ");
  }
  if (Array.isArray(result.choices)) {
    const messageContent = result.choices[0]?.message?.content;
    const text = readContent(messageContent);
    if (text) return text;
    return result.choices[0]?.text || "";
  }
  return "";
}

function normalizeSummary(value) {
  const normalized = value
    .replace(/[\r\n]+/g, " ")
    .replace(/^["'「『\s]+|["'」』\s]+$/g, "")
    .replace(/^AI要約[:：]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length <= 180) return normalized;

  const clipped = normalized.slice(0, 180);
  const lastSentenceEnd = Math.max(
    clipped.lastIndexOf("。"),
    clipped.lastIndexOf("！"),
    clipped.lastIndexOf("？")
  );
  if (lastSentenceEnd > 70) return clipped.slice(0, lastSentenceEnd + 1).trim();
  return clipped.trim();
}

function fallbackSummary({ title, description, articleText }) {
  const source = description && description.length > 80 ? description : articleText;
  if (source && source.length > 80) {
    return source
      .replace(/\s+/g, " ")
      .replace(/^(概要|はじめに|対象読者|導入|本文)\s+/, "")
      .split(/[。.!?]/)
      .filter(Boolean)
      .slice(0, 2)
      .join("。")
      .slice(0, 140)
      .trim();
  }

  const shortSource = description || title || "";
  if (!shortSource.trim()) return "";
  return shortSource
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .split(/[。.!?]/)[0]
    .slice(0, 120)
    .trim();
}

function buildSummaryPrompt({ title, description, siteName, articleText }) {
  const sourceText = [
    `タイトル: ${title}`,
    `概要: ${description}`,
    `サイト: ${siteName}`,
    `本文抜粋: ${articleText.slice(0, 700)}`,
  ].filter(line => line.replace(/^[^:]+:\s*/, "").trim()).join("\n");

  return {
    sourceText,
    instruction: `以下の記事本文を、内容が分かるように日本語で2行程度に要約してください。ハッシュタグやキーワード列挙は使わず、普通の文章の要約だけを出力してください。\n\n${sourceText}`,
  };
}

async function generateGeminiSummary(env, summaryInput) {
  if (!env?.GEMINI_API_KEY) return "";

  const model = env.GEMINI_MODEL || "gemini-3.1-flash-lite";
  const { instruction } = buildSummaryPrompt(summaryInput);
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `あなたは日本語ネイティブの編集者です。Web記事の内容を、自然で読みやすい読書メモとして要約します。出力は要約文だけにしてください。\n\n${instruction}`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.35,
        maxOutputTokens: 180,
      },
    }),
    signal: AbortSignal.timeout(25000),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `Gemini failed: ${response.status}`);

  return normalizeSummary(
    data.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join(" ") || ""
  );
}

async function generateWorkersAiSummary(env, summaryInput) {
  if (!env?.AI) return "";
  const { instruction } = buildSummaryPrompt(summaryInput);
  const result = await env.AI.run("@cf/google/gemma-4-26b-a4b-it", {
    prompt: instruction,
    max_completion_tokens: 2200,
    reasoning_effort: "none",
    temperature: 0.25,
    top_p: 0.9,
  });

  return normalizeSummary(getAiResponseText(result));
}

async function generateSummary(env, { title, description, siteName, articleText }) {
  const summaryInput = { title, description, siteName, articleText };
  const { sourceText } = buildSummaryPrompt(summaryInput);
  if (!sourceText.trim()) return "";

  try {
    const geminiSummary = await generateGeminiSummary(env, summaryInput);
    if (geminiSummary.length >= 24 && geminiSummary !== title) return geminiSummary;
  } catch (err) {
    console.warn("Gemini summary failed", err);
  }

  try {
    const workersAiSummary = await generateWorkersAiSummary(env, summaryInput);
    if (workersAiSummary.length >= 24 && workersAiSummary !== title) return workersAiSummary;
  } catch (err) {
    console.warn("Workers AI summary failed", err);
  }

  return fallbackSummary({ title, description, articleText });
}

async function handleRequest(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  const requestUrl = new URL(request.url);
  const target = requestUrl.searchParams.get("url");
  if (!target) return json({ error: "Missing url parameter" }, 400);

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return json({ error: "Invalid URL" }, 400);
  }

  if (!["http:", "https:"].includes(targetUrl.protocol) || isBlockedHost(targetUrl.hostname)) {
    return json({ error: "Blocked URL" }, 400);
  }

  const upstream = await fetch(targetUrl.href, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PrivateSanctuaryUrlPreview/1.0)",
      Accept: "text/html,application/xhtml+xml",
    },
    cf: { cacheTtl: 3600, cacheEverything: true },
    signal: AbortSignal.timeout(7000),
  });

  if (!upstream.ok) {
    return json({ error: `Fetch failed: ${upstream.status}` }, 502);
  }

  const contentType = upstream.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    return json({ error: "Target is not HTML" }, 415);
  }

  const html = await upstream.text();
  const title = findMeta(html, ["og:title", "twitter:title"]) || findTitle(html);
  const description = findMeta(html, ["og:description", "twitter:description", "description"]);
  const image = absoluteUrl(findMeta(html, ["og:image", "twitter:image", "twitter:image:src"]), targetUrl.href);
  const siteName = findMeta(html, ["og:site_name", "application-name"]) || targetUrl.hostname.replace(/^www\./, "");
  const articleText = findArticleText(html);
  const summary = await generateSummary(env, { title, description, siteName, articleText });

  return json({
    url: targetUrl.href,
    title,
    description,
    image,
    siteName,
    summary,
  });
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
