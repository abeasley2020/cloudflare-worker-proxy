// src/worker.js
var SHEETS_WEBHOOK = "https://script.google.com/macros/s/AKfycbwLfmwdNbp9eadoDP29UiZvKPUlMdkXfbGkY5yKGandB-WEMFqIQpud4Tjh2-dDla25/exec";
var corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
var worker_default = {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }
    try {
      const body = await request.json();
      if (!body.passphrase || body.passphrase !== env.TEAM_PASSPHRASE) {
        return new Response(JSON.stringify({ error: "Invalid passphrase. Contact Andre for access." }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
      if (body.tool === "workout-log") {
        try {
          const sheetsRes = await fetch(env.WORKOUT_SHEETS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "appendLog",
              week: body.week,
              day: body.day,
              exercise: body.exercise,
              setNum: body.setNum,
              weight: body.weight,
              reps: body.reps,
              unit: body.unit || "lbs"
            }),
            redirect: "follow"
          });
          if (!sheetsRes.ok) {
            return new Response(JSON.stringify({ error: "Sheets webhook failed", status: sheetsRes.status }), {
              status: 502,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }
          const sheetsData = await sheetsRes.json();
          return new Response(JSON.stringify(sheetsData), {
            status: sheetsRes.status,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: "Sheets webhook failed", status: 502 }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }
      }
      if (body.tool === "workout-get") {
        try {
          const sheetsUrl = new URL(env.WORKOUT_SHEETS_URL);
          sheetsUrl.searchParams.set("action", "getLog");
          if (body.week !== void 0) sheetsUrl.searchParams.set("week", body.week);
          if (body.day !== void 0) sheetsUrl.searchParams.set("day", body.day);
          const sheetsRes = await fetch(sheetsUrl, {
            method: "GET",
            redirect: "follow"
          });
          if (!sheetsRes.ok) {
            return new Response(JSON.stringify({ error: "Sheets webhook failed", status: sheetsRes.status }), {
              status: 502,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }
          const sheetsData = await sheetsRes.json();
          return new Response(JSON.stringify(sheetsData), {
            status: sheetsRes.status,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: "Sheets webhook failed", status: 502 }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }
      }
      const anthropicPayload = {
        model: body.model || "claude-sonnet-4-20250514",
        max_tokens: body.max_tokens || 2e3,
        system: body.system,
        messages: body.messages
      };
      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(anthropicPayload)
      });
      const data = await anthropicRes.json();
      const outputText = (data.content || []).map((b) => b.text || "").join("");
      const tool = body.tool || "unknown";
      const auditPayload = { tool };
      if (tool === "sme") {
        auditPayload.reviewerName = body.reviewerName || "";
        auditPayload.courseName = body.courseName || "";
        auditPayload.facultyName = body.facultyName || "";
        auditPayload.program = body.program || "";
        auditPayload.briefGenerated = (/* @__PURE__ */ new Date()).toISOString();
      }
      if (tool === "ada") {
        auditPayload.reviewerName = body.reviewerName || "";
        auditPayload.courseName = body.courseName || "";
        auditPayload.contentTitle = body.contentTitle || "";
        auditPayload.format = body.format || "";
        const riskMatch = outputText.match(/risk level[:\s]*(high|medium|low)/i);
        auditPayload.riskLevel = riskMatch ? riskMatch[1].toUpperCase() : "UNKNOWN";
        const failMatches = outputText.match(/WCAG \d+\.\d+/g);
        auditPayload.violationCount = failMatches ? failMatches.length : 0;
        auditPayload.summary = outputText.slice(0, 300).replace(/\n/g, " ");
      }
      ctx.waitUntil(
        fetch(SHEETS_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(auditPayload),
          redirect: "follow"
        }).catch(() => {
        })
      );
      if (tool === "sme" && env.RESEND_API_KEY) {
        const courseName = body.courseName || "New Course";
        ctx.waitUntil(
          fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${env.RESEND_API_KEY}`
            },
            body: JSON.stringify({
              from: "SME Interview Agent <onboarding@resend.dev>",
              to: "beasleya@purdue.edu",
              subject: `ID Brief Ready: ${courseName}`,
              html: `
                <div style="font-family:Georgia,serif;max-width:700px;margin:0 auto;padding:32px;color:#1A1A1A;">
                  <div style="border-bottom:2px solid #0D0D0D;padding-bottom:16px;margin-bottom:32px;">
                    <p style="font-family:monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#C8973A;margin:0 0 8px;">Purdue Course Production \xB7 SME Interview</p>
                    <h1 style="font-size:24px;margin:0 0 4px;">${courseName}</h1>
                    <p style="font-size:13px;color:#7A7570;margin:0;">ID Brief generated ${(/* @__PURE__ */ new Date()).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</p>
                    ${body.reviewerName ? `<p style="font-size:13px;color:#7A7570;margin:4px 0 0;">Submitted by: ${body.reviewerName}</p>` : ""}
                  </div>
                  <div style="font-size:15px;line-height:1.7;">${outputText.replace(/## /g, '<h2 style="font-size:18px;margin:28px 0 8px;border-bottom:1px solid #E2DDD8;padding-bottom:6px;">').replace(/### /g, '<h3 style="font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#C8973A;margin:20px 0 6px;">').replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</div>
                  <div style="margin-top:40px;padding-top:20px;border-top:1px solid #E2DDD8;font-size:12px;color:#7A7570;font-family:monospace;">Sent automatically by the CDD SME Interview Agent</div>
                </div>
              `
            })
          }).catch(() => {
          })
        );
      }
      return new Response(JSON.stringify(data), {
        status: anthropicRes.status,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
