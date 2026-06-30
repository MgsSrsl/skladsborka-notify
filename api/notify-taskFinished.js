export default async function handler(req) {
    console.log("OLD notify-taskFinished CALLED (DISABLED)");
    console.log("method:", req.method);

    const ua = req.headers?.["user-agent"];
    const origin = req.headers?.["origin"];
    const referer = req.headers?.["referer"];

    console.log("ua:", ua);
    console.log("origin:", origin);
    console.log("referer:", referer);

    let body = null;
    try {
        body = await req.json();
    } catch {
        try {
            body = await req.text();
        } catch {}
    }

    console.log("body:", body);

    return new Response("endpoint disabled", {
        status: 410,
        headers: {
            "Content-Type": "text/plain"
        }
    });
}
