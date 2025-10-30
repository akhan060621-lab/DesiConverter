interface Env {
  ADMIN_EMAIL: string;
  FROM_EMAIL: string;
  SITE_NAME: string;
  TURNSTILE_SECRET?: string;
  MAILCHANNELS_DRY_RUN?: string;
}

const MC_ENDPOINT = "https://api.mailchannels.net/tx/v1/send";

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== "POST") {
    return context.next();
  }
  return handlePost(context);
};

async function handlePost({ request, env, waitUntil }: Parameters<PagesFunction<Env>>[0]) {
  try {
    const form = await request.formData();
    const name = (form.get("name") || "").toString().trim();
    const email = (form.get("email") || "").toString().trim();
    const message = (form.get("message") || "").toString().trim();
    const turnstileToken = (form.get("cf-turnstile-response") || "").toString();
    const redirectTarget = (form.get("_redirect") || "thank-you.html").toString().trim() || "thank-you.html";

    if (!name || !email || !message) {
      return new Response("Missing fields", { status: 400 });
    }

    const missingConfig = ["ADMIN_EMAIL", "FROM_EMAIL", "SITE_NAME"].filter(
      (key) => !(env as Record<string, unknown>)[key]
    );
    if (missingConfig.length > 0) {
      console.error("contact config missing", missingConfig);
      return new Response("Email service misconfigured", { status: 500 });
    }

    const adminEmail = env.ADMIN_EMAIL;
    const fromEmail = env.FROM_EMAIL;
    const siteName = env.SITE_NAME;
    const dryRun = isTruthy(env.MAILCHANNELS_DRY_RUN);

    if (env.TURNSTILE_SECRET && turnstileToken) {
      const passed = await verifyTurnstile(turnstileToken, request, env.TURNSTILE_SECRET);
      if (!passed) return new Response("Human verification failed", { status: 400 });
    }

    const submittedAt = new Date().toISOString();

    const mailJobs = Promise.all([
      sendMail({
        to: adminEmail,
        from: fromEmail,
        subject: `New contact — ${siteName}`,
        text: `Name: ${name}\nEmail: ${email}\nWhen: ${submittedAt}\n\n${message}`,
        replyTo: email,
        fromName: siteName,
        dryRun,
      }),
      sendMail({
        to: email,
        from: fromEmail,
        subject: `Thanks for contacting ${siteName}`,
        text: `Hi ${name},\n\nThanks for reaching out to ${siteName}. We received your message on ${submittedAt} and will reply soon.\n\nYour message:\n${message}\n\n— ${siteName}`,
        replyTo: adminEmail,
        fromName: siteName,
        dryRun,
      }),
    ]);

    if (waitUntil) {
      waitUntil(
        mailJobs.catch((err) => {
          console.error("contact email dispatch failed", err);
        })
      );
    }

    await mailJobs;

    const wantsJson = request.headers.get("accept")?.includes("application/json");
    if (wantsJson) {
      return Response.json({ ok: true });
    }

    const redirectUrl = new URL(redirectTarget, request.url);
    return Response.redirect(redirectUrl.toString(), 303);
  } catch (err) {
    console.error("contact handler error", err);
    return new Response("Server error", { status: 500 });
  }
}

async function sendMail({
  to,
  from,
  subject,
  text,
  replyTo,
  fromName,
  dryRun,
}: {
  to: string;
  from: string;
  subject: string;
  text: string;
  replyTo?: string;
  fromName?: string;
  dryRun?: boolean;
}) {
  const payload: Record<string, unknown> = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: from, name: fromName || "Desi Converter" },
    subject,
    content: [{ type: "text/plain", value: text }],
  };
  if (replyTo) {
    payload.reply_to = { email: replyTo };
  }

  if (dryRun) {
    console.info("MailChannels dry run payload", payload);
    return;
  }

  const res = await fetch(MC_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error("MailChannels error response", res.status, detail);
    throw new Error(`MailChannels ${res.status}: ${detail}`);
  }
}

async function verifyTurnstile(token: string, request: Request, secret: string): Promise<boolean> {
  try {
    const cfResponse = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret,
        response: token,
        remoteip: request.headers.get("CF-Connecting-IP") ?? "",
      }),
    });
    const data = await cfResponse.json();
    return Boolean(data.success);
  } catch (error) {
    console.error("Turnstile verify error", error);
    return false;
  }
}

function isTruthy(value?: string): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
