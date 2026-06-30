export default async function handler(req) {
    try {
        console.log("OLD notify-taskFinished CALLED");
        console.log("method:", req.method);
        console.log("ua:", req.headers.get("user-agent"));
        console.log("origin:", req.headers.get("origin"));
        console.log("referer:", req.headers.get("referer"));

        let body = null;
        try {
            body = await req.json();
        } catch (e) {
            body = await req.text();
        }

        console.log("body:", body);

        return new Response("endpoint disabled", {
            status: 410,
            headers: {
                "Content-Type": "text/plain"
            }
        });

    } catch (err) {
        console.log("notify-taskFinished error:", err);

        return new Response("disabled", {
            status: 410
        });
    }
}
