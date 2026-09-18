// netlify/functions/send-push.js
// Sends a real device push notification via OneSignal's REST API.
//
// Why this needs to be a server-side function and not a direct browser
// call: OneSignal's REST API Key is a secret. Calling OneSignal directly
// from client-side JS (the old approach) means that key sits in plain
// text in index.html — anyone can view-source the page, copy it, and use
// it to send push notifications to your users too. This keeps it only
// ever on the server.
//
// Set these in Netlify → Site configuration → Environment variables:
//   ONESIGNAL_APP_ID           (safe to also hardcode client-side — it's
//                                public by design, this var is just for
//                                convenience so it's not duplicated)
//   ONESIGNAL_REST_API_KEY     (secret — starts with os_v2_app_)
// Both come from OneSignal dashboard → Settings → Keys & IDs.
//
// Auth note: os_v2_app_-prefixed keys are OneSignal's current "App API
// Key" format, which uses the `Key` auth scheme and the api.onesignal.com
// host — not the `Basic` scheme + onesignal.com/api/v1 host that older
// Legacy REST API Keys used. Mixing the two (new key + old scheme) gets
// rejected with a 401/403.

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const appId = process.env.ONESIGNAL_APP_ID;
  const restApiKey = process.env.ONESIGNAL_REST_API_KEY;
  if (!appId || !restApiKey) {
    // Fail soft — a misconfigured/missing push setup should never break
    // the feature that triggered it (posting a matchup/clip still works
    // fine even if the push itself can't be sent).
    return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: 'OneSignal not configured' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { title, body } = payload;
  if (!title || !body) {
    return { statusCode: 400, body: JSON.stringify({ error: 'title and body are required' }) };
  }

  try {
    const oneSignalRes = await fetch('https://api.onesignal.com/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Key ${restApiKey}`
      },
      body: JSON.stringify({
        app_id: appId,
        target_channel: 'push',
        included_segments: ['Total Subscriptions'],
        headings: { en: String(title).slice(0, 100) },
        contents: { en: String(body).slice(0, 200) }
      })
    });

    const data = await oneSignalRes.json().catch(() => ({}));

    if (!oneSignalRes.ok) {
      console.error('OneSignal API error:', oneSignalRes.status, data);
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'OneSignal request failed', status: oneSignalRes.status, details: data })
      };
    }

    console.log('OneSignal API success:', data);
    return {
      statusCode: 200,
      body: JSON.stringify({
        sent: true,
        id: data.id || null,
        recipients: data.recipients ?? null,
        raw: data
      })
    };
  } catch (err) {
    console.error('send-push handler error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
