/**
 * Allowed MIME types for uploads. Used to reject unexpected file types (e.g. executables).
 * Supports exact match (e.g. 'application/pdf') or prefix (e.g. 'image/').
 */
const EXACT = (mime) => (v) => v === mime;
const PREFIX = (p) => (v) => v && v.startsWith(p);

/** Allowlist of safe extensions (lowercase, no leading dot). Reject double extensions and executables. */
const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'doc', 'docx', 'webm', 'mp4', 'mp3', 'wav', 'm4a',
]);

/**
 * Reject dangerous extensions and double extensions (e.g. file.pdf.exe).
 * @param {string} originalname - Original filename from client
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function validateFileExtension(originalname) {
  if (!originalname || typeof originalname !== 'string') return { allowed: false, reason: 'missing filename' };
  const base = originalname.trim();
  if (base.length > 255) return { allowed: false, reason: 'filename too long' };
  const parts = base.split('.');
  if (parts.length > 2) return { allowed: false, reason: 'double extension not allowed' };
  const ext = (parts.length === 2 ? parts.pop() : '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (ext && !ALLOWED_EXTENSIONS.has(ext)) return { allowed: false, reason: 'file type not allowed' };
  const dangerous = /\.(exe|bat|cmd|sh|ps1|js|vbs|jar|php|phtml|asp|aspx|cgi)$/i;
  if (dangerous.test(base)) return { allowed: false, reason: 'executable not allowed' };
  return { allowed: true };
}

/**
 * Sanitize display name for storage (strip path chars, limit length). Never use for filesystem path.
 * @param {string} name - User-provided or original filename
 * @param {number} maxLen - Max length (default 255)
 */
export function sanitizeDisplayName(name, maxLen = 255) {
  if (name == null) return 'Document';
  const s = String(name).replace(/[/\\<>:"|?*\x00-\x1f]/g, '').trim();
  return (s || 'Document').slice(0, maxLen);
}

/** Progress media: photos, videos, drone footage */
export const ALLOWED_MEDIA_MIMES = [
  EXACT('image/jpeg'),
  EXACT('image/png'),
  EXACT('image/gif'),
  EXACT('image/webp'),
  PREFIX('video/'),
];

/** Project documents: PDFs and images */
export const ALLOWED_DOCUMENT_MIMES = [
  EXACT('application/pdf'),
  EXACT('image/jpeg'),
  EXACT('image/png'),
  EXACT('image/gif'),
  EXACT('image/webp'),
];

/** Images only (for covers, previews, listing photos) */
export const ALLOWED_IMAGE_MIMES = [
  EXACT('image/jpeg'),
  EXACT('image/png'),
  EXACT('image/gif'),
  EXACT('image/webp'),
];

/** Invoice attachments: PDF, images, and Word docs (stored in `pdf_url` for compatibility). */
export const ALLOWED_INVOICE_MIMES = [
  EXACT('application/pdf'),
  EXACT('image/jpeg'),
  EXACT('image/png'),
  EXACT('image/gif'),
  EXACT('image/webp'),
  EXACT('application/msword'),
  EXACT('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
];

/** KYC: ID/passport images and PDF */
export const ALLOWED_KYC_MIMES = [
  PREFIX('image/'),
  EXACT('application/pdf'),
];

/** Chat attachments: images, video, audio, PDF */
export const ALLOWED_CHAT_MIMES = [
  PREFIX('image/'),
  PREFIX('video/'),
  PREFIX('audio/'),
  EXACT('application/pdf'),
];

function isAllowed(mimetype, allowed) {
  if (!mimetype || typeof mimetype !== 'string') return false;
  const m = mimetype.toLowerCase().trim();
  return allowed.some((fn) => fn(m));
}

/**
 * Ensure declared media_type matches actual file MIME (photo = images only; video/drone = video only).
 * @returns {string|null} Error message or null if OK
 */
export function validateMediaCategoryMime(media_type, mimetype) {
  const mime = (mimetype || '').toLowerCase().trim();
  if (media_type === 'photo') {
    if (!mime.startsWith('image/')) {
      return 'Photos must be image files: PNG, JPG, JPEG, WEBP, or GIF.';
    }
  }
  if (media_type === 'video' || media_type === 'drone') {
    if (!mime.startsWith('video/')) {
      return 'Video and drone uploads must be video files: MP4, WEBM, or similar.';
    }
  }
  return null;
}

/**
 * Multer fileFilter factory. Rejects disallowed MIME types with a clear error.
 * @param {Array<Function>} allowed - List of EXACT/PREFIX matchers from this file
 * @param {string} label - e.g. 'Media upload'
 */
export function fileFilter(allowed, label = 'File') {
  return (req, file, cb) => {
    const mime = file.mimetype;
    const extCheck = validateFileExtension(file.originalname);
    if (!extCheck.allowed) {
      return cb(new Error(`${label}: ${extCheck.reason || 'invalid filename'}`));
    }
    if (isAllowed(mime, allowed)) {
      cb(null, true);
    } else {
      cb(new Error(`${label}: only allowed file types are accepted. Got: ${mime || 'unknown'}`));
    }
  };
}
