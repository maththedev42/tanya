# Safety Rules — Tanya

## Code Security
- Never hardcode API keys, tokens, or secrets in source code
- Always use environment variables for sensitive configuration
- Never commit .env files — use .env.example with placeholders
- All API keys stored in system keychain or secure enclave, never UserDefaults or SharedPreferences

## Data & Privacy (LGPD Compliance)
- Never log personally identifiable information (PII)
- User data encrypted at rest using AES-256
- Provide data deletion endpoint — users can delete account and all data
- Collect only minimum data necessary for each feature
- Document all data collection in privacy policy

## Input Validation
- Validate and sanitize ALL user inputs before processing
- Never trust client-side data on the backend
- Use parameterized queries — never string interpolation in SQL
- Validate file uploads: type, size, and content

## Authentication & Authorization
- JWT tokens expire in 15 minutes — use refresh tokens
- Refresh tokens expire in 30 days and rotate on use
- Rate limit auth endpoints: max 5 attempts per minute
- All authenticated routes verify token on every request
- Never expose user IDs in URLs — use opaque tokens

## Network Security
- HTTPS only — reject HTTP connections
- Certificate pinning for mobile apps
- Security headers: HSTS, X-Frame-Options, X-Content-Type-Options, CSP
- CORS: whitelist specific origins only, never wildcard in production

## Mobile Specific
- No sensitive data in logs (including debug logs)
- No sensitive data in clipboard unless explicitly requested by user
- Biometric authentication for sensitive operations
- App Transport Security enabled on iOS

## Agent Rules
- Before modifying any file, read its current content
- Never delete files without explicit instruction
- Run tests after every significant change
- If unsure about a security decision, default to the more restrictive option
- Document all security-relevant decisions in code comments
- Follow brand rules for all UI changes
