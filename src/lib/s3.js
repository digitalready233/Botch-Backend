/**
 * S3 upload helper. When AWS credentials are set, uploads to S3 and returns URL.
 * Optional CloudFront URL for CDN. Falls back to local if not configured — does not throw.
 */

const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID?.trim();
const AWS_SECRET = process.env.AWS_SECRET_ACCESS_KEY?.trim();
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const AWS_BUCKET = process.env.AWS_S3_BUCKET?.trim();
const CLOUDFRONT_URL = process.env.CLOUDFRONT_URL?.replace(/\/$/, ''); // no trailing slash

export function isS3Configured() {
  return !!(AWS_ACCESS_KEY && AWS_SECRET && AWS_BUCKET);
}

/**
 * Upload buffer to S3. Key can be e.g. "media/abc123.jpg" or "invoices/inv-xyz.pdf"
 * @param {Buffer} buffer
 * @param {string} key - S3 object key
 * @param {string} [contentType] - e.g. 'image/jpeg', 'application/pdf'
 * @returns {Promise<string|null>} - Public URL (CloudFront if set, else S3), or null if S3 not configured
 */
export async function uploadToS3(buffer, key, contentType = 'application/octet-stream') {
  if (!isS3Configured()) return null;
  try {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({
      region: AWS_REGION,
      credentials: { accessKeyId: AWS_ACCESS_KEY, secretAccessKey: AWS_SECRET },
    });
    await client.send(
      new PutObjectCommand({
        Bucket: AWS_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      })
    );
    if (CLOUDFRONT_URL) {
      return `${CLOUDFRONT_URL}/${key}`;
    }
    return `https://${AWS_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;
  } catch (err) {
    console.error('[s3] Upload failed:', err.message);
    return null;
  }
}
