// Netlify serverless function — commits state.json to GitHub
// Env vars required (set in Netlify dashboard):
//   GITHUB_TOKEN    — fine-grained PAT with Contents R/W on smilehaus/rcm-dashboard
//   PUBLISH_PASSWORD — must match the manager PIN in the dashboard (default: smilehaus2024)

const REPO = 'smilehaus/rcm-dashboard';
const FILE = 'state.json';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: 'Method not allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { state, password } = body;
  const expectedPassword = process.env.PUBLISH_PASSWORD || 'smilehaus2024';

  if (!password || password !== expectedPassword) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Invalid password' }) };
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Server not configured (missing GITHUB_TOKEN)' }) };
  }

  try {
    // Get current SHA of state.json
    const getRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
      }
    });
    if (!getRes.ok) throw new Error('Could not fetch current state.json: ' + getRes.status);
    const current = await getRes.json();

    // Encode new content
    const content = Buffer.from(JSON.stringify(state, null, 2)).toString('base64');

    // Commit
    const putRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: 'Publish dashboard state [skip ci]',
        content,
        sha: current.sha,
      }),
    });

    if (!putRes.ok) {
      const err = await putRes.json();
      throw new Error(err.message || 'Commit failed: ' + putRes.status);
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
