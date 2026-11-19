# Frontend resource and cache policy

## Resource states

Frontend resource detail views distinguish deleted (410), expired (419), private
(401/403), missing (404), and unavailable (network/server) responses. Private
responses use the same neutral copy as every user without permission and do not
expose the resource identifier, owner, or existence beyond a generic permission
message.

## Account isolation

Authentication transitions clear the in-memory React Query cache. Account
changes also remove account-specific search, draft, pending-confession, settings,
scroll, and auth state from client storage. Query data is never reused until the
new account is explicitly resolved.

## Cache policy manifest

`xconfess-frontend/cache-policy-manifest.json` declares public and private route
classes. Private API and admin routes must not be returned with shared-cache
directives. Public routes may be cached only when they contain no authentication
credentials or account-specific content.

CI runs `npm run validate:cache-policy --workspace=xconfess-frontend` to reject
invalid classifications and accidental public labels for account or admin routes.
