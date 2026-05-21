/**
 * Optional hardening for GET /uploads/*.
 * When UPLOADS_PROXY_SECRET is set, only requests that send the same value in
 * header X-Botch-Uploads-Proxy can read files. The Next.js /uploads route should
 * set this header server-side so browsers never see the secret.
 * If the env var is unset, behavior is unchanged (public read of paths under /uploads).
 */

export function requireUploadsProxySecret(req, res, next) {
  const secret = (process.env.UPLOADS_PROXY_SECRET || '').trim();
  if (!secret) return next();
  const sent = (req.get('x-botch-uploads-proxy') || '').trim();
  if (sent === secret) return next();
  res.status(403).type('text/plain').send('Access denied.');
}
