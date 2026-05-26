// src/worker.js
var SHEETS_WEBHOOK = "https://script.google.com/macros/s/AKfycbwLfmwdNbp9eadoDP29UiZvKPUlMdkXfbGkY5yKGandB-WEMFqIQpud4Tjh2-dDla25/exec";
var corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

// SME-facing tools that authenticate via magic-link token, not passphrase
var SME_TOOLS = new Set([
  "intake-session-load",
  "intake-message",
  "intake-synthesize",
  "intake-brief-load",
  "intake-brief-update",
  "intake-approve"
]);

async function validateIntakeToken(env, token) {
  if (!token || typeof token !== "string" || token.length < 32) {
    return null;
  }
  return await env.INTAKE_DB.prepare(
    `SELECT id, magic_link_token, faculty_name, faculty_email, course_title, id_owner, id_email, status, progress_json, created_at, updated_at, completed_at
     FROM intakes WHERE magic_link_token = ?`
  ).bind(token).first();
}

var INTAKE_SYSTEM_PROMPT = `You are an instructional design colleague at Purdue University, helping a faculty member share what they know about an upcoming course they will teach online. This conversation happens BEFORE their kickoff meeting with the assigned instructional designer. The purpose is to give the ID a head start so the kickoff meeting is productive.

YOU ARE TALKING TO A SENIOR PROFESSIONAL. Match that register.

TONE RULES:
- Professional, dry, and direct. Like a competent colleague who values their time.
- NEVER validate or reassure the faculty member about their feelings, knowledge, or readiness. Skip phrases like "that's a great point," "completely natural," "that sounds wonderful," "many faculty feel that way." These are empty calories.
- NEVER praise the faculty member's audience, course, expertise, or answers. Just take in the information and move forward.
- Use the faculty member's name at most twice in the entire conversation. Not on every turn.
- Ask ONE question per turn. Never stack questions.
- If the faculty member says "I'm not sure yet" or similar, accept it cleanly with one short acknowledgment ("Got it." or "We can come back to that.") and move to the next thing. Do not offer extensive reassurance.
- Do not narrate what you are doing ("Let me ask about...", "Now I want to understand...")
- No exclamation points unless the faculty uses them first.

CONTENT RULES:
- Cover five domains in soft order, letting the faculty member steer where helpful:
  1. course_identity: What is the course? Level, format, audience, credit hours, when it runs.
  2. learning_aims: What should students walk away able to do?
  3. existing_materials: What do they already have? (syllabus, slides, readings, prior versions)
  4. content_readiness: What are they clear on? What is still forming? What is wide open?
  5. working_preferences: How do they like to communicate? Availability? Preferred tools?
- Start with course_identity unless the faculty member directs you elsewhere.
- Move on once you have enough to give the ID a useful starting point. Do not interrogate.

OUTPUT FORMAT:
Respond with valid JSON only, in this exact shape:
{
  "message": "Your reply to the faculty member",
  "domain": "course_identity | learning_aims | existing_materials | content_readiness | working_preferences",
  "domain_complete": false,
  "ready_for_synthesis": false
}

Set "domain_complete" to true only when the current domain has enough for the ID to work with.
Set "ready_for_synthesis" to true only when all five domains are at least lightly covered AND the faculty member shows signs of being ready to wrap up.

CLOSING THE CONVERSATION:
When you set "ready_for_synthesis" to true, your "message" field MUST end with this exact sentence, on its own line, as the final line of the message:
"Someone from Purdue Course Production will be in touch by email to schedule your kickoff meeting."
Before that line, write a brief, dry acknowledgment (one short sentence — e.g., "Thanks. I have what I need."). No restating of what was covered. No effusive thanks. The closing sentence must appear verbatim — do not paraphrase, expand, or substitute names.

CRITICAL OUTPUT REQUIREMENTS:
- Your entire response must be a single JSON object and nothing else.
- Do not wrap the JSON in markdown code fences (no triple backticks, no "json" language tag).
- Do not include any prose, explanation, or formatting before or after the JSON.
- The first character of your response must be { and the last character must be }.
- If you violate these rules, the response will be unusable to the user.`;

async function callClaudeForIntake(env, conversationHistory) {
  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: INTAKE_SYSTEM_PROMPT,
      messages: conversationHistory
    })
  });
  const data = await anthropicRes.json();
  let text = (data.content || []).map((b) => b.text || "").join("").trim();
  // Strip markdown code fences if Claude wraps the JSON
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(text);
  } catch (err) {
    // Fallback: if Claude failed to return clean JSON, wrap the raw text
    return {
      message: text || "I'm sorry, something went wrong on my end. Could you say that again?",
      domain: "course_identity",
      domain_complete: false,
      ready_for_synthesis: false,
      _parse_error: true
    };
  }
}

// ---------------------------------------------------------------------------
// Email helpers (Resend)
// ---------------------------------------------------------------------------
// Both helpers are best-effort and fire from within ctx.waitUntil at the call
// site. Failures are logged but do not block the response — intake creation
// and approval must succeed even if the email layer is misconfigured.

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Send the magic-link invite to the faculty member.
async function sendMagicLinkEmail(env, intake) {
  if (!env.RESEND_API_KEY) return;
  if (!intake.faculty_email) return;
  const courseTitle = intake.course_title || "your upcoming course";
  const magicLink = `https://course-intake.vercel.app/s/${intake.magic_link_token}`;
  const fromName = intake.id_owner || "Purdue Course Production";
  const subject = `Pre-kickoff intake for ${courseTitle}`;
  const html = `
    <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:32px;color:#1A1A1A;">
      <div style="border-bottom:2px solid #0D0D0D;padding-bottom:16px;margin-bottom:24px;">
        <p style="font-family:monospace;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#C8973A;margin:0 0 8px;">Purdue Course Production · Pre-Kickoff Intake</p>
        <h1 style="font-size:22px;margin:0;">${escapeHtml(courseTitle)}</h1>
      </div>
      <p style="font-size:15px;line-height:1.6;">Dear ${escapeHtml(intake.faculty_name)},</p>
      <p style="font-size:15px;line-height:1.6;">
        ${escapeHtml(fromName)} has invited you to share what you know about
        <strong>${escapeHtml(courseTitle)}</strong> before your kickoff meeting.
      </p>
      <p style="font-size:15px;line-height:1.6;">
        This is a short, informal conversation — usually 10–20 minutes. There
        are no wrong answers, and "I'm not sure yet" is always a valid
        response. Your progress is saved automatically; you can close the tab
        and come back anytime.
      </p>
      <div style="margin:28px 0;text-align:center;">
        <a href="${magicLink}" style="display:inline-block;background:#0D0D0D;color:#FFFFFF;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:15px;font-weight:500;">
          Begin the intake →
        </a>
      </div>
      <p style="font-size:13px;color:#7A7570;line-height:1.6;">
        Or copy this link into your browser:<br>
        <span style="font-family:monospace;font-size:12px;word-break:break-all;">${magicLink}</span>
      </p>
      <div style="margin-top:32px;padding-top:16px;border-top:1px solid #E2DDD8;font-size:12px;color:#7A7570;font-family:monospace;">
        Sent by Purdue Course Production on behalf of ${escapeHtml(fromName)}.
      </div>
    </div>
  `;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: "Purdue Course Production <onboarding@resend.dev>",
        to: intake.faculty_email,
        subject,
        html
      })
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`Magic-link email failed (${res.status}) for intake ${intake.id}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`Magic-link email exception for intake ${intake.id}:`, err);
  }
}

// Render the merged BriefV1 view as HTML for the approval email.
function renderBriefAsHtml(brief) {
  const base = brief.content_json || {};
  const edits = brief.sme_edits_json || {};
  const merge = (key) => ({ ...(base[key] || {}), ...(edits[key] || {}) });
  const ci = merge("course_identity");
  const la = merge("learning_aims");
  const em = merge("existing_materials");
  const cr = merge("content_readiness");
  const wp = merge("working_preferences");
  const oq = edits.open_questions_for_kickoff ?? base.open_questions_for_kickoff ?? [];

  const h2 = (t) => `<h2 style="font-size:16px;margin:24px 0 6px;border-bottom:1px solid #E2DDD8;padding-bottom:4px;text-transform:uppercase;letter-spacing:.06em;font-family:monospace;color:#0D0D0D;">${escapeHtml(t)}</h2>`;
  const dt = (label, value) => value ? `<p style="margin:4px 0;font-size:14px;"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>` : "";
  const list = (label, items) => {
    if (!items || !items.length) return "";
    const lis = items.map((it) => `<li style="margin:2px 0;">${escapeHtml(it)}</li>`).join("");
    return `<p style="margin:8px 0 4px;font-size:14px;"><strong>${escapeHtml(label)}:</strong></p><ul style="margin:0 0 8px 20px;padding:0;font-size:14px;line-height:1.5;">${lis}</ul>`;
  };

  const materialsList = (em.items || []).map((it) => {
    const parts = [];
    if (it.name) parts.push(`<strong>${escapeHtml(it.name)}</strong>`);
    if (it.type) parts.push(`<em>(${escapeHtml(it.type)})</em>`);
    if (it.notes) parts.push(`— ${escapeHtml(it.notes)}`);
    return parts.length ? `<li style="margin:3px 0;">${parts.join(" ")}</li>` : "";
  }).filter(Boolean).join("");

  return [
    h2("Course Identity"),
    dt("Audience", ci.audience),
    dt("Level", ci.level),
    dt("Delivery format", ci.delivery_format),
    dt("Estimated credits or hours", ci.estimated_credits_or_hours),

    h2("Learning Aims"),
    list("Primary outcomes", la.primary_outcomes),
    list("Secondary outcomes", la.secondary_outcomes),
    la.notes ? `<p style="margin:4px 0;font-size:14px;"><strong>Notes:</strong> ${escapeHtml(la.notes)}</p>` : "",

    h2("Existing Materials"),
    materialsList ? `<ul style="margin:0 0 8px 20px;padding:0;font-size:14px;line-height:1.5;">${materialsList}</ul>` : "",
    em.summary ? `<p style="margin:4px 0;font-size:14px;"><strong>Summary:</strong> ${escapeHtml(em.summary)}</p>` : "",

    h2("Content Readiness"),
    list("Clear", cr.clear),
    list("Still forming", cr.forming),
    list("Wide open", cr.open),

    h2("Working Preferences"),
    dt("Communication", wp.communication),
    dt("Availability", wp.availability),
    dt("Tools", wp.tools),
    dt("Concerns", wp.concerns),

    oq.length ? h2("Open Questions for Kickoff") + list("", oq) : "",
  ].join("");
}

// ---------------------------------------------------------------------------
// Audit logging (Google Sheets)
// ---------------------------------------------------------------------------
// Lifecycle events for the intake tool are POSTed to the same SHEETS_WEBHOOK
// the legacy `sme` / `ada` tools already use. The Apps Script endpoint just
// appends whatever JSON arrives, so we don't need a schema lock-step — we
// include the canonical event/tool/intake_id keys plus whatever metadata is
// useful for the row. No message bodies or notes content is sent (PII +
// length concerns); just metadata that supports aggregate analysis.
function auditIntakeEvent(ctx, payload) {
  ctx.waitUntil(
    fetch(SHEETS_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, ts: new Date().toISOString() }),
      redirect: "follow"
    }).catch(() => {})
  );
}

// Notify the ID that the SME approved their brief.
async function sendApprovalEmail(env, intake, brief) {
  if (!env.RESEND_API_KEY) return;
  if (!intake.id_email) return; // older intakes created before id_email existed
  const courseTitle = intake.course_title || "Untitled course";
  const subject = `Brief approved — ${courseTitle} (${intake.faculty_name})`;
  const briefHtml = renderBriefAsHtml(brief);
  const html = `
    <div style="font-family:Georgia,serif;max-width:700px;margin:0 auto;padding:32px;color:#1A1A1A;">
      <div style="border-bottom:2px solid #0D0D0D;padding-bottom:16px;margin-bottom:24px;">
        <p style="font-family:monospace;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#C8973A;margin:0 0 8px;">Purdue Course Production · Intake Approved</p>
        <h1 style="font-size:22px;margin:0 0 4px;">${escapeHtml(courseTitle)}</h1>
        <p style="font-size:13px;color:#7A7570;margin:0;">Approved by ${escapeHtml(intake.faculty_name)}</p>
      </div>
      <p style="font-size:15px;line-height:1.6;">
        ${escapeHtml(intake.faculty_name)} has reviewed and approved the
        pre-kickoff intake brief. The full brief is below. Open the admin
        dashboard to add your notes before the kickoff.
      </p>
      <div style="margin:20px 0;text-align:left;">
        <a href="https://course-intake.vercel.app/admin" style="display:inline-block;background:#0D0D0D;color:#FFFFFF;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:500;">
          Open dashboard →
        </a>
      </div>
      ${briefHtml}
      <div style="margin-top:32px;padding-top:16px;border-top:1px solid #E2DDD8;font-size:12px;color:#7A7570;font-family:monospace;">
        Sent by the Purdue Course Production Course Intake Agent.
      </div>
    </div>
  `;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: "Purdue Course Production <onboarding@resend.dev>",
        to: intake.id_email,
        subject,
        html
      })
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`Approval email failed (${res.status}) for intake ${intake.id}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`Approval email exception for intake ${intake.id}:`, err);
  }
}

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

      // SME-FACING DISPATCH (magic-link token auth, no passphrase required)
      if (SME_TOOLS.has(body.tool)) {
        const token = (body.token || "").trim();
        const intake = await validateIntakeToken(env, token);
        if (!intake) {
          return new Response(JSON.stringify({ error: "Invalid or expired link. Contact your instructional designer." }), {
            status: 401,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        if (body.tool === "intake-session-load") {
          try {
            const messages = await env.INTAKE_DB.prepare(
              `SELECT id, role, content, question_domain, created_at
               FROM intake_messages WHERE intake_id = ? ORDER BY created_at ASC`
            ).bind(intake.id).all();
            return new Response(JSON.stringify({ intake, messages: messages.results || [] }), {
              status: 200,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          } catch (err) {
            return new Response(JSON.stringify({ error: "Failed to load session", detail: err.message }), {
              status: 500,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }
        }

        if (body.tool === "intake-message") {
          const smeMessage = (body.message || "").trim();
          if (!smeMessage) {
            return new Response(JSON.stringify({ error: "message is required" }), {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }

          try {
            // Persist the SME's message
            const smeMessageId = crypto.randomUUID();
            await env.INTAKE_DB.prepare(
              `INSERT INTO intake_messages (id, intake_id, role, content, question_domain)
               VALUES (?, ?, 'sme', ?, ?)`
            ).bind(smeMessageId, intake.id, smeMessage, null).run();

            // Load full conversation history (now including the message we just inserted)
            const historyResult = await env.INTAKE_DB.prepare(
              `SELECT role, content FROM intake_messages WHERE intake_id = ? ORDER BY created_at ASC`
            ).bind(intake.id).all();

            // Build context for Claude: prepend a hidden context message with the faculty's name and course
            const contextPreamble = `[Context for you, not visible to faculty: You are speaking with ${intake.faculty_name}. The course they will be teaching is ${intake.course_title || "(not yet titled)"}.]`;
            const conversationHistory = [];
            // First user turn includes the preamble so Claude has context
            const historyRows = historyResult.results || [];
            if (historyRows.length === 1) {
              // First message from SME, prepend context
              conversationHistory.push({
                role: "user",
                content: `${contextPreamble}\n\n${historyRows[0].content}`
              });
            } else {
              for (let i = 0; i < historyRows.length; i++) {
                const row = historyRows[i];
                conversationHistory.push({
                  role: row.role === "sme" ? "user" : "assistant",
                  content: row.content
                });
              }
            }

            // Call Claude
            const claudeResponse = await callClaudeForIntake(env, conversationHistory);
            const agentMessage = claudeResponse.message || "I'm here. What were you thinking?";
            const domain = claudeResponse.domain || null;
            const domainComplete = claudeResponse.domain_complete === true;
            const readyForSynthesis = claudeResponse.ready_for_synthesis === true;

            // Persist the agent's response
            const agentMessageId = crypto.randomUUID();
            await env.INTAKE_DB.prepare(
              `INSERT INTO intake_messages (id, intake_id, role, content, question_domain)
               VALUES (?, ?, 'agent', ?, ?)`
            ).bind(agentMessageId, intake.id, agentMessage, domain).run();

            // Update progress_json if a domain was marked complete
            if (domainComplete && domain) {
              const currentProgress = JSON.parse(intake.progress_json || "{}");
              currentProgress[domain] = "complete";
              await env.INTAKE_DB.prepare(
                `UPDATE intakes SET progress_json = ?, status = 'in_progress', updated_at = datetime('now') WHERE id = ?`
              ).bind(JSON.stringify(currentProgress), intake.id).run();
            } else {
              // Always bump updated_at and ensure status reflects activity
              await env.INTAKE_DB.prepare(
                `UPDATE intakes SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?`
              ).bind(intake.id).run();
            }

            return new Response(JSON.stringify({
              message: agentMessage,
              domain,
              domain_complete: domainComplete,
              ready_for_synthesis: readyForSynthesis,
              progress: JSON.parse(intake.progress_json || "{}")
            }), {
              status: 200,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          } catch (err) {
            return new Response(JSON.stringify({ error: "Failed to process message", detail: err.message }), {
              status: 500,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }
        }

        if (body.tool === "intake-synthesize") {
          try {
            // Pull the full message history for synthesis
            const historyResult = await env.INTAKE_DB.prepare(
              `SELECT role, content FROM intake_messages WHERE intake_id = ? ORDER BY created_at ASC`
            ).bind(intake.id).all();
            const historyRows = historyResult.results || [];

            if (historyRows.length === 0) {
              return new Response(JSON.stringify({ error: "No conversation to synthesize. Complete the intake conversation first." }), {
                status: 400,
                headers: { "Content-Type": "application/json", ...corsHeaders }
              });
            }

            // Build conversation transcript for the synthesis prompt
            const transcript = historyRows.map(row => {
              const speaker = row.role === "sme" ? "Faculty" : "Agent";
              return `${speaker}: ${row.content}`;
            }).join("\n\n");

            const synthesisSystemPrompt = `You are synthesizing a pre-kickoff course intake conversation into a structured brief for an instructional designer at Purdue University.

You will receive the full transcript of a conversation between an intake agent and a faculty member (the SME). Your job is to extract and organize what was said into the exact JSON schema below — nothing more, nothing less.

RULES:
- Output valid JSON only. No markdown, no code fences, no prose before or after the JSON.
- The first character of your response must be { and the last must be }.
- Every field in the schema must be present, even if the conversation did not cover it (use empty string, empty array, or a note like "Not discussed" for missing content).
- Do not invent or infer information that was not stated or strongly implied in the conversation.
- If the faculty member said "I'm not sure yet" or equivalent, reflect that honestly (e.g., "Not yet determined").
- Write in third person (e.g., "The faculty member indicated..." or just state facts directly without attribution).
- Be concise. The ID will use this as a working document, not a transcript summary.
- schema_version must always be exactly the string "v1".

OUTPUT SCHEMA (emit this exact shape):
{
  "schema_version": "v1",
  "course_identity": {
    "title": "string — course title or 'Not yet titled'",
    "audience": "string — who takes this course",
    "level": "string — undergraduate/graduate/professional/etc.",
    "delivery_format": "string — online async/sync/hybrid/in-person",
    "estimated_credits_or_hours": "string — e.g. '3 credit hours' or 'Not discussed'"
  },
  "learning_aims": {
    "primary_outcomes": ["string — what students will be able to do"],
    "secondary_outcomes": ["string — secondary or supporting outcomes"],
    "notes": "string — any caveats, context, or 'Not discussed'"
  },
  "existing_materials": {
    "items": [{"name": "string", "type": "string — e.g. slides/syllabus/readings/prior course", "notes": "string"}],
    "summary": "string — overall state of existing materials"
  },
  "content_readiness": {
    "clear": ["string — topics or sections the faculty member is confident about"],
    "forming": ["string — things still being worked out"],
    "open": ["string — genuinely open questions or unknowns"]
  },
  "working_preferences": {
    "communication": "string — preferred communication channel and style",
    "availability": "string — when they are reachable",
    "tools": "string — preferred authoring or collaboration tools",
    "concerns": "string — anything they flagged as a concern or constraint"
  },
  "open_questions_for_kickoff": ["string — questions that should be on the kickoff agenda"]
}`;

            const synthesisRes = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": env.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01"
              },
              body: JSON.stringify({
                model: "claude-sonnet-4-20250514",
                max_tokens: 4096,
                system: synthesisSystemPrompt,
                messages: [
                  {
                    role: "user",
                    content: `Here is the intake conversation transcript for ${intake.faculty_name} (course: ${intake.course_title || "not yet titled"}):\n\n${transcript}\n\nSynthesize this into the structured brief JSON.`
                  }
                ]
              })
            });

            const synthesisData = await synthesisRes.json();
            let rawText = (synthesisData.content || []).map(b => b.text || "").join("").trim();
            // Strip markdown code fences if present
            rawText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

            let briefContent;
            try {
              briefContent = JSON.parse(rawText);
            } catch (parseErr) {
              return new Response(JSON.stringify({
                error: "Synthesis produced invalid JSON. Try again.",
                detail: parseErr.message,
                raw: rawText.slice(0, 500)
              }), {
                status: 502,
                headers: { "Content-Type": "application/json", ...corsHeaders }
              });
            }

            // Enforce schema_version = "v1"
            briefContent.schema_version = "v1";

            // Upsert into briefs: replace if already exists for this intake
            const existingBrief = await env.INTAKE_DB.prepare(
              `SELECT id FROM briefs WHERE intake_id = ?`
            ).bind(intake.id).first();

            let briefId;
            if (existingBrief) {
              // Re-synthesis: update the existing brief, clear prior SME edits and approval
              briefId = existingBrief.id;
              await env.INTAKE_DB.prepare(
                `UPDATE briefs SET content_json = ?, sme_edits_json = NULL, sme_approved_at = NULL, updated_at = datetime('now') WHERE id = ?`
              ).bind(JSON.stringify(briefContent), briefId).run();
            } else {
              // First synthesis
              briefId = crypto.randomUUID();
              await env.INTAKE_DB.prepare(
                `INSERT INTO briefs (id, intake_id, schema_version, content_json) VALUES (?, ?, 'v1', ?)`
              ).bind(briefId, intake.id, JSON.stringify(briefContent)).run();
            }

            // Transition intake status to sme_review
            await env.INTAKE_DB.prepare(
              `UPDATE intakes SET status = 'sme_review', updated_at = datetime('now') WHERE id = ?`
            ).bind(intake.id).run();

            auditIntakeEvent(ctx, {
              tool: "intake-synthesize",
              event: "brief_synthesized",
              intake_id: intake.id,
              course_title: intake.course_title || "",
              faculty_name: intake.faculty_name,
              id_owner: intake.id_owner,
              message_count: historyRows.length,
              resynthesized: !!existingBrief
            });

            return new Response(JSON.stringify({
              brief_id: briefId,
              schema_version: "v1",
              brief: briefContent,
              status: "sme_review",
              resynthesized: !!existingBrief
            }), {
              status: 200,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          } catch (err) {
            return new Response(JSON.stringify({ error: "Failed to synthesize brief", detail: err.message }), {
              status: 500,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }
        }

        if (body.tool === "intake-brief-load") {
          try {
            const briefRow = await env.INTAKE_DB.prepare(
              `SELECT id, intake_id, schema_version, content_json, sme_edits_json, sme_approved_at, created_at, updated_at
               FROM briefs WHERE intake_id = ?`
            ).bind(intake.id).first();

            if (!briefRow) {
              // No brief yet — return null so the frontend can show "synthesis not run yet"
              return new Response(JSON.stringify({ intake, brief: null }), {
                status: 200,
                headers: { "Content-Type": "application/json", ...corsHeaders }
              });
            }

            const brief = {
              id: briefRow.id,
              intake_id: briefRow.intake_id,
              schema_version: briefRow.schema_version,
              content_json: JSON.parse(briefRow.content_json),
              sme_edits_json: briefRow.sme_edits_json ? JSON.parse(briefRow.sme_edits_json) : null,
              sme_approved_at: briefRow.sme_approved_at,
              created_at: briefRow.created_at,
              updated_at: briefRow.updated_at
            };

            return new Response(JSON.stringify({ intake, brief }), {
              status: 200,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          } catch (err) {
            return new Response(JSON.stringify({ error: "Failed to load brief", detail: err.message }), {
              status: 500,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }
        }

        if (body.tool === "intake-brief-update") {
          try {
            const briefRow = await env.INTAKE_DB.prepare(
              `SELECT id, intake_id, schema_version, content_json, sme_edits_json, sme_approved_at, created_at, updated_at
               FROM briefs WHERE intake_id = ?`
            ).bind(intake.id).first();

            if (!briefRow) {
              return new Response(JSON.stringify({ error: "No brief to edit — synthesize first." }), {
                status: 400,
                headers: { "Content-Type": "application/json", ...corsHeaders }
              });
            }

            // body.edits is a partial object — accept whatever the SME sends, no rigid schema check
            const edits = body.edits != null ? body.edits : {};

            await env.INTAKE_DB.prepare(
              `UPDATE briefs SET sme_edits_json = ?, updated_at = datetime('now') WHERE id = ?`
            ).bind(JSON.stringify(edits), briefRow.id).run();

            // Reload the updated row so updated_at is fresh
            const updatedBriefRow = await env.INTAKE_DB.prepare(
              `SELECT id, intake_id, schema_version, content_json, sme_edits_json, sme_approved_at, created_at, updated_at
               FROM briefs WHERE id = ?`
            ).bind(briefRow.id).first();

            const brief = {
              id: updatedBriefRow.id,
              intake_id: updatedBriefRow.intake_id,
              schema_version: updatedBriefRow.schema_version,
              content_json: JSON.parse(updatedBriefRow.content_json),
              sme_edits_json: updatedBriefRow.sme_edits_json ? JSON.parse(updatedBriefRow.sme_edits_json) : null,
              sme_approved_at: updatedBriefRow.sme_approved_at,
              created_at: updatedBriefRow.created_at,
              updated_at: updatedBriefRow.updated_at
            };

            return new Response(JSON.stringify({ intake, brief }), {
              status: 200,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          } catch (err) {
            return new Response(JSON.stringify({ error: "Failed to update brief", detail: err.message }), {
              status: 500,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }
        }

        if (body.tool === "intake-approve") {
          try {
            const briefRow = await env.INTAKE_DB.prepare(
              `SELECT id, intake_id, schema_version, content_json, sme_edits_json, sme_approved_at, created_at, updated_at
               FROM briefs WHERE intake_id = ?`
            ).bind(intake.id).first();

            if (!briefRow) {
              return new Response(JSON.stringify({ error: "No brief to approve — synthesize first." }), {
                status: 400,
                headers: { "Content-Type": "application/json", ...corsHeaders }
              });
            }

            // Idempotency: if already approved, return current state without error
            if (intake.status === "sme_approved") {
              const brief = {
                id: briefRow.id,
                intake_id: briefRow.intake_id,
                schema_version: briefRow.schema_version,
                content_json: JSON.parse(briefRow.content_json),
                sme_edits_json: briefRow.sme_edits_json ? JSON.parse(briefRow.sme_edits_json) : null,
                sme_approved_at: briefRow.sme_approved_at,
                created_at: briefRow.created_at,
                updated_at: briefRow.updated_at
              };
              return new Response(JSON.stringify({ intake, brief }), {
                status: 200,
                headers: { "Content-Type": "application/json", ...corsHeaders }
              });
            }

            // State machine guard: approve only fires from sme_review
            if (intake.status !== "sme_review") {
              return new Response(JSON.stringify({
                error: `Cannot approve from status '${intake.status}'. Intake must be in 'sme_review' to approve.`
              }), {
                status: 400,
                headers: { "Content-Type": "application/json", ...corsHeaders }
              });
            }

            // Set approval timestamp on brief and transition intake status
            await env.INTAKE_DB.prepare(
              `UPDATE briefs SET sme_approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
            ).bind(briefRow.id).run();

            await env.INTAKE_DB.prepare(
              `UPDATE intakes SET status = 'sme_approved', updated_at = datetime('now') WHERE id = ?`
            ).bind(intake.id).run();

            // Reload both rows so timestamps reflect the updates
            const updatedIntake = await env.INTAKE_DB.prepare(
              `SELECT id, magic_link_token, faculty_name, faculty_email, course_title, id_owner, id_email, status, progress_json, created_at, updated_at, completed_at
               FROM intakes WHERE id = ?`
            ).bind(intake.id).first();

            const updatedBriefRow = await env.INTAKE_DB.prepare(
              `SELECT id, intake_id, schema_version, content_json, sme_edits_json, sme_approved_at, created_at, updated_at
               FROM briefs WHERE id = ?`
            ).bind(briefRow.id).first();

            const brief = {
              id: updatedBriefRow.id,
              intake_id: updatedBriefRow.intake_id,
              schema_version: updatedBriefRow.schema_version,
              content_json: JSON.parse(updatedBriefRow.content_json),
              sme_edits_json: updatedBriefRow.sme_edits_json ? JSON.parse(updatedBriefRow.sme_edits_json) : null,
              sme_approved_at: updatedBriefRow.sme_approved_at,
              created_at: updatedBriefRow.created_at,
              updated_at: updatedBriefRow.updated_at
            };

            // Fire-and-forget approval notification to the ID. Non-fatal —
            // the brief is approved in D1 regardless of email delivery.
            ctx.waitUntil(sendApprovalEmail(env, updatedIntake, brief));

            auditIntakeEvent(ctx, {
              tool: "intake-approve",
              event: "brief_approved",
              intake_id: updatedIntake.id,
              course_title: updatedIntake.course_title || "",
              faculty_name: updatedIntake.faculty_name,
              id_owner: updatedIntake.id_owner,
              sme_approved_at: brief.sme_approved_at
            });

            return new Response(JSON.stringify({ intake: updatedIntake, brief }), {
              status: 200,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          } catch (err) {
            return new Response(JSON.stringify({ error: "Failed to approve brief", detail: err.message }), {
              status: 500,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }
        }

        return new Response(JSON.stringify({ error: `Tool ${body.tool} not yet implemented` }), {
          status: 501,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // ID-FACING AND LEGACY TOOLS (passphrase required)
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

      if (body.tool === "intake-create") {
        const id = crypto.randomUUID();
        const tokenBytes = new Uint8Array(32);
        crypto.getRandomValues(tokenBytes);
        const token = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, "0")).join("");
        const facultyName = (body.facultyName || "").trim();
        const facultyEmail = (body.facultyEmail || "").trim();
        const courseTitle = (body.courseTitle || "").trim();
        const idOwner = (body.idOwner || body.reviewerName || "").trim();
        const idEmail = (body.idEmail || "").trim();
        if (!facultyName || !facultyEmail || !idOwner) {
          return new Response(JSON.stringify({ error: "facultyName, facultyEmail, and idOwner are required" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }
        try {
          await env.INTAKE_DB.prepare(
            `INSERT INTO intakes (id, magic_link_token, faculty_name, faculty_email, course_title, id_owner, id_email, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'created')`
          ).bind(id, token, facultyName, facultyEmail, courseTitle, idOwner, idEmail || null).run();
          const magicLink = `https://course-intake.vercel.app/s/${token}`;
          // Fire-and-forget magic-link email to the faculty member. Non-fatal —
          // the intake exists in D1 regardless; the ID can still copy the link
          // from the dashboard if the email fails.
          ctx.waitUntil(sendMagicLinkEmail(env, {
            id,
            magic_link_token: token,
            faculty_name: facultyName,
            faculty_email: facultyEmail,
            course_title: courseTitle,
            id_owner: idOwner,
            id_email: idEmail
          }));
          auditIntakeEvent(ctx, {
            tool: "intake-create",
            event: "intake_created",
            intake_id: id,
            course_title: courseTitle || "",
            faculty_name: facultyName,
            faculty_email: facultyEmail,
            id_owner: idOwner,
            id_email: idEmail || ""
          });
          return new Response(JSON.stringify({ id, token, magicLink, status: "created" }), {
            status: 201,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: "Failed to create intake", detail: err.message }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }
      }

      // ---- intake-list: list intakes owned by the requesting ID ----
      if (body.tool === "intake-list") {
        const idOwner = (body.idOwner || "").trim();
        if (!idOwner) {
          return new Response(JSON.stringify({ error: "idOwner is required" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }
        try {
          const result = await env.INTAKE_DB.prepare(
            `SELECT id, magic_link_token, faculty_name, faculty_email, course_title, id_owner, id_email, status, progress_json, created_at, updated_at, completed_at
             FROM intakes WHERE id_owner = ? ORDER BY updated_at DESC`
          ).bind(idOwner).all();
          const intakes = (result.results || []).map((row) => ({
            ...row,
            magicLink: `https://course-intake.vercel.app/s/${row.magic_link_token}`
          }));
          return new Response(JSON.stringify({ intakes }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: "Failed to list intakes", detail: err.message }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }
      }

      // ---- intake-admin-detail: full intake (messages + brief + ID notes) ----
      if (body.tool === "intake-admin-detail") {
        const intakeId = (body.intake_id || "").trim();
        if (!intakeId) {
          return new Response(JSON.stringify({ error: "intake_id is required" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }
        try {
          const intakeRow = await env.INTAKE_DB.prepare(
            `SELECT id, magic_link_token, faculty_name, faculty_email, course_title, id_owner, id_email, status, progress_json, created_at, updated_at, completed_at
             FROM intakes WHERE id = ?`
          ).bind(intakeId).first();
          if (!intakeRow) {
            return new Response(JSON.stringify({ error: "Intake not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }
          const messagesResult = await env.INTAKE_DB.prepare(
            `SELECT id, role, content, question_domain, created_at
             FROM intake_messages WHERE intake_id = ? ORDER BY created_at ASC`
          ).bind(intakeId).all();
          const briefRow = await env.INTAKE_DB.prepare(
            `SELECT id, intake_id, schema_version, content_json, sme_edits_json, sme_approved_at, id_received_at, id_notes, created_at, updated_at
             FROM briefs WHERE intake_id = ?`
          ).bind(intakeId).first();
          const brief = briefRow ? {
            id: briefRow.id,
            intake_id: briefRow.intake_id,
            schema_version: briefRow.schema_version,
            content_json: JSON.parse(briefRow.content_json),
            sme_edits_json: briefRow.sme_edits_json ? JSON.parse(briefRow.sme_edits_json) : null,
            sme_approved_at: briefRow.sme_approved_at,
            id_received_at: briefRow.id_received_at,
            id_notes: briefRow.id_notes,
            created_at: briefRow.created_at,
            updated_at: briefRow.updated_at
          } : null;
          return new Response(JSON.stringify({
            intake: intakeRow,
            messages: messagesResult.results || [],
            brief
          }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: "Failed to load intake detail", detail: err.message }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }
      }

      // ---- intake-admin-notes: ID writes notes against the brief ----
      // First note from an `sme_approved` intake transitions status to `id_received`
      // and stamps `briefs.id_received_at`. Subsequent edits just update notes.
      if (body.tool === "intake-admin-notes") {
        const intakeId = (body.intake_id || "").trim();
        const notes = typeof body.notes === "string" ? body.notes : "";
        if (!intakeId) {
          return new Response(JSON.stringify({ error: "intake_id is required" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }
        try {
          const intakeRow = await env.INTAKE_DB.prepare(
            `SELECT id, magic_link_token, faculty_name, faculty_email, course_title, id_owner, id_email, status, progress_json, created_at, updated_at, completed_at
             FROM intakes WHERE id = ?`
          ).bind(intakeId).first();
          if (!intakeRow) {
            return new Response(JSON.stringify({ error: "Intake not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }
          const briefRow = await env.INTAKE_DB.prepare(
            `SELECT id, intake_id, schema_version, content_json, sme_edits_json, sme_approved_at, id_received_at, id_notes, created_at, updated_at
             FROM briefs WHERE intake_id = ?`
          ).bind(intakeId).first();
          if (!briefRow) {
            return new Response(JSON.stringify({ error: "No brief to attach notes to — synthesize first." }), {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }
          const shouldTransition = intakeRow.status === "sme_approved" && !briefRow.id_received_at;
          if (shouldTransition) {
            await env.INTAKE_DB.prepare(
              `UPDATE briefs SET id_notes = ?, id_received_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
            ).bind(notes, briefRow.id).run();
            await env.INTAKE_DB.prepare(
              `UPDATE intakes SET status = 'id_received', updated_at = datetime('now') WHERE id = ?`
            ).bind(intakeRow.id).run();
          } else {
            await env.INTAKE_DB.prepare(
              `UPDATE briefs SET id_notes = ?, updated_at = datetime('now') WHERE id = ?`
            ).bind(notes, briefRow.id).run();
          }
          const updatedIntake = await env.INTAKE_DB.prepare(
            `SELECT id, magic_link_token, faculty_name, faculty_email, course_title, id_owner, id_email, status, progress_json, created_at, updated_at, completed_at
             FROM intakes WHERE id = ?`
          ).bind(intakeRow.id).first();
          const updatedBriefRow = await env.INTAKE_DB.prepare(
            `SELECT id, intake_id, schema_version, content_json, sme_edits_json, sme_approved_at, id_received_at, id_notes, created_at, updated_at
             FROM briefs WHERE id = ?`
          ).bind(briefRow.id).first();
          const brief = {
            id: updatedBriefRow.id,
            intake_id: updatedBriefRow.intake_id,
            schema_version: updatedBriefRow.schema_version,
            content_json: JSON.parse(updatedBriefRow.content_json),
            sme_edits_json: updatedBriefRow.sme_edits_json ? JSON.parse(updatedBriefRow.sme_edits_json) : null,
            sme_approved_at: updatedBriefRow.sme_approved_at,
            id_received_at: updatedBriefRow.id_received_at,
            id_notes: updatedBriefRow.id_notes,
            created_at: updatedBriefRow.created_at,
            updated_at: updatedBriefRow.updated_at
          };
          auditIntakeEvent(ctx, {
            tool: "intake-admin-notes",
            event: shouldTransition ? "id_received" : "notes_updated",
            intake_id: updatedIntake.id,
            course_title: updatedIntake.course_title || "",
            faculty_name: updatedIntake.faculty_name,
            id_owner: updatedIntake.id_owner,
            notes_length: notes.length,
            transitioned_to_id_received: shouldTransition
          });
          return new Response(JSON.stringify({ intake: updatedIntake, brief }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: "Failed to update notes", detail: err.message }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }
      }

      // Legacy Anthropic passthrough for sme, ada, and other tools
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