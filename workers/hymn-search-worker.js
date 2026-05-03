/**
 * 诗歌在线搜索 Worker（免费模拟版）
 * 部署：在项目根或本目录使用 Wrangler，入口指向本文件（module worker）。
 */
export default {
    async fetch(request, env, ctx) {
        if (request.method === "OPTIONS") {
            return new Response(null, {
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                    "Access-Control-Max-Age": "86400"
                }
            });
        }

        if (request.method !== "GET") {
            return new Response(JSON.stringify({ error: "仅支持 GET" }), {
                status: 405,
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*"
                }
            });
        }

        const url = new URL(request.url);
        const keyword = (url.searchParams.get("q") || "").trim();

        if (!keyword) {
            return new Response(JSON.stringify({ error: "请输入搜索关键词" }), {
                status: 400,
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*"
                }
            });
        }

        try {
            const results = [];

            const numMatch = keyword.match(/^\d+$/);
            if (numMatch) {
                const content = `这是对诗歌第 ${keyword} 首的模拟搜索结果。在真正的付费 API 接入前，你可以在这里看到搜索功能是通的。`;
                results.push({
                    title: `诗歌第 ${keyword} 首`,
                    content,
                    lyrics: content,
                    source: "本地模拟"
                });
            }

            const content = `云端诗歌库正在建设中。接入真实 API 后，这里将显示真正的搜索结果。你搜索的关键词是：${keyword}`;
            results.push({
                title: `搜索：包含「${keyword}」的赞美诗`,
                content,
                lyrics: content,
                source: "云端 Worker"
            });

            return new Response(JSON.stringify(results), {
                status: 200,
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "public, max-age=300"
                }
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return new Response(JSON.stringify({ error: "搜索处理失败", detail }), {
                status: 500,
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*"
                }
            });
        }
    }
};
