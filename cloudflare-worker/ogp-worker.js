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
      "Cache-Control": status === 200 ? "public, max-age=3600" : "no-store",
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
  if (typeof result.output_text === "string") return result.output_text;
  if (typeof result.response === "string") return result.response;
  if (typeof result.text === "string") return result.text;
  if (typeof result.result?.response === "string") return result.result.response;
  if (typeof result.result?.text === "string") return result.result.text;
  if (Array.isArray(result.output)) {
    return result.output
      .flatMap(item => item.content || [])
      .map(content => content.text || (content.type === "output_text" ? content.text : ""))
      .filter(Boolean)
      .join(" ");
  }
  if (Array.isArray(result.choices)) {
    return result.choices[0]?.message?.content || result.choices[0]?.text || "";
  }
  return "";
}

function normalizeSummary(value) {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/^["'「『\s]+|["'」』\s]+$/g, "")
    .replace(/^AI要約[:：]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 70)
    .replace(/[、,][^、,]*$/, "")
    .trim();
}

function fallbackSummary({ title, description }) {
  const source = description || title || "";
  if (!source.trim()) return "";
  return source
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .split(/[。.!?]/)[0]
    .slice(0, 55)
    .trim();
}

async function generateSummary(env, { title, description, siteName }) {
  const sourceText = [title, description, siteName].filter(Boolean).join("\n");
  if (!env?.AI || !sourceText.trim()) return "";

  try {
    const result = await env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
      messages: [
        {
          role: "system",
          content: "あなたはWebページの内容を日本語で短く要約する編集者です。出力は要約文だけにしてください。",
        },
        {
          role: "user",
          content: `次のWebページ情報を、日本語25文字以内の自然な1行で要約してください。説明ではなく「何のページか」だけを短く書いてください。宣伝口調、URL、サイト名だけの繰り返し、箇条書き、句点は避けてください。\n\n${sourceText}`,
        },
      ],
      max_tokens: 48,
      max_completion_tokens: 80,
      temperature: 0.2,
    });

    const summary = normalizeSummary(getAiResponseText(result));
    if (summary.length < 8) return fallbackSummary({ title, description });
    return summary;
  } catch (err) {
    console.warn("Workers AI summary failed", err);
    return fallbackSummary({ title, description });
  }
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
  const summary = await generateSummary(env, { title, description, siteName });

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
