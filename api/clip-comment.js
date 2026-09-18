// netlify/functions/clip-comment.js
// Server-authoritative comment posting for movie clips. Same pattern as
// comment.js (matchup comments): verifies identity and pulls the poster's
// profile fields from Firestore server-side. Does NOT award XP — XP only
// comes from backing the winning side of a vote (see vote.js /
// settle-matchup.js). Requires the same FIREBASE_SERVICE_ACCOUNT_KEY env
// var as vote.js/comment.js.

import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    ),
  });
}

const db = admin.firestore();

const MAX_COMMENT_LENGTH = 500;

// Mirrors APP_STICKERS in app.js/comment.js — kept in sync manually since
// this file can't import from the client bundle.
const APP_STICKERS = [
  { id: 'pow', requiresXp: 100 },
  { id: 'ko', requiresXp: 200 },
  { id: 'level-up', requiresXp: 300 },
  { id: 'skill-issue', requiresXp: 400 },
  { id: 'votes-in', requiresXp: 500 },
  { id: 'shattered', requiresXp: 600 },
  { id: 'clash', requiresXp: 700 },
  { id: 'lit', requiresXp: 800 },
  { id: 'hero', requiresXp: 900 },
  { id: 'underrated', requiresXp: 1000 },
  { id: 'vs', requiresXp: 1100 },
];

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { clipId, text, replyTo, stickerId } = payload;
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const idToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  const trimmedText = typeof text === 'string' ? text.trim() : '';
  const requestedStickerId = typeof stickerId === 'string' && stickerId.trim() ? stickerId.trim() : null;
  if (!clipId || (!trimmedText && !requestedStickerId)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'clipId and text or stickerId are required' }) };
  }
  if (trimmedText.length > MAX_COMMENT_LENGTH) {
    return { statusCode: 400, body: JSON.stringify({ error: `Comment too long (max ${MAX_COMMENT_LENGTH} chars)` }) };
  }
  // See comment.js for why this is trusted-but-sanitized rather than
  // re-fetched from the original comment — purely a decorative quoted
  // preview, same treatment as Discord's own reply UI. replyToUid is the
  // one exception, used only to address a notification (see comment.js).
  let replyToName = null;
  let replyToText = null;
  let replyToAvatarUrl = null;
  let replyToUid = null;
  if (replyTo && typeof replyTo === 'object') {
    if (typeof replyTo.name === 'string' && replyTo.name.trim()) {
      replyToName = replyTo.name.trim().slice(0, 60);
    }
    if (typeof replyTo.text === 'string' && replyTo.text.trim()) {
      replyToText = replyTo.text.trim().slice(0, 120);
    }
    if (typeof replyTo.avatarUrl === 'string' && replyTo.avatarUrl.length < 500000) {
      replyToAvatarUrl = replyTo.avatarUrl;
    }
    if (typeof replyTo.uid === 'string' && replyTo.uid.trim()) {
      replyToUid = replyTo.uid.trim();
    }
  }
  if (!idToken) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Missing auth token' }) };
  }

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (err) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired auth token' }) };
  }

  try {
    const clipSnap = await db.collection('movieClips').doc(clipId).get();
    if (!clipSnap.exists) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Clip not found' }) };
    }

    // Pull the poster's current profile fields server-side rather than
    // trusting whatever the client sends, so a comment's name/avatar/
    // decoration can't be spoofed to impersonate someone else.
    let name = 'User';
    let avatarUrl = null;
    let decorationId = null;
    let xp = 0;
    const userSnap = await db.collection('users').doc(uid).get();
    if (userSnap.exists) {
      const u = userSnap.data();
      name = u.name || name;
      avatarUrl = u.avatarUrl || null;
      decorationId = u.equippedDecoration || null;
      xp = u.xp || 0;
    }

    // Validate the sticker server-side against the uid's actual current
    // xp — see comment.js for why this check (not just the client-side
    // picker) is what actually stops a locked sticker being attached.
    let resolvedStickerId = null;
    if (requestedStickerId) {
      const stickerDef = APP_STICKERS.find(s => s.id === requestedStickerId);
      if (!stickerDef) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Unknown sticker' }) };
      }
      if (xp < stickerDef.requiresXp) {
        return {
          statusCode: 403,
          body: JSON.stringify({ error: `Sticker locked — reach ${stickerDef.requiresXp} XP to unlock it` })
        };
      }
      resolvedStickerId = stickerDef.id;
    }

    const commentRef = db.collection('movieClips').doc(clipId).collection('comments').doc();
    await commentRef.set({
      text: trimmedText,
      stickerId: resolvedStickerId,
      name,
      avatarUrl,
      decorationId,
      replyToName,
      replyToText,
      replyToAvatarUrl,
      uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Notify the person being replied to — see comment.js for the same
    // pattern and reasoning (self-reply skipped, best-effort so a failure
    // here never fails the comment post itself).
    if (replyToUid && replyToUid !== uid) {
      try {
        await db
          .collection('users')
          .doc(replyToUid)
          .collection('notifications')
          .add({
            type: 'reply',
            fromUid: uid,
            fromName: name,
            fromAvatarUrl: avatarUrl,
            text: trimmedText ? trimmedText.slice(0, 160) : (resolvedStickerId ? '[sticker]' : ''),
            clipId,
            commentId: commentRef.id,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
      } catch (notifyErr) {
        console.error('Reply notification write failed (comment still posted):', notifyErr);
      }
    }

    // Comments no longer award XP — only backing the winning side of a
    // vote does (see vote.js / settle-matchup.js).
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        commentId: commentRef.id,
        xpAwarded: 0,
        rank: null,
      })
    };
  } catch (err) {
    console.error('Clip comment post failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
