# Business rules — Authentication

Rule text lives in [`07_Business_Rules.md`](../07_Business_Rules.md); this file is the
per-module index the [module catalog](../Modules/Authentication.md) links into.

| Rule                                                                                                                           | Statement                                            |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| <a id="br-auth-001"></a>[BR-AUTH-001](../07_Business_Rules.md#br-auth-001-login-failure-is-uniform-and-constant-time)          | Login failure is uniform and constant-time           |
| <a id="br-auth-002"></a>[BR-AUTH-002](../07_Business_Rules.md#br-auth-002-the-permission-list-is-never-in-the-token)           | The permission list is never in the token            |
| <a id="br-auth-003"></a>[BR-AUTH-003](../07_Business_Rules.md#br-auth-003-refresh-tokens-rotate-and-replay-revokes-the-family) | Refresh tokens rotate, and replay revokes the family |
| <a id="br-auth-004"></a>[BR-AUTH-004](../07_Business_Rules.md#br-auth-004-tokens-are-asymmetric-in-kind-on-purpose)            | Tokens are asymmetric in kind, on purpose            |
| <a id="br-auth-005"></a>[BR-AUTH-005](../07_Business_Rules.md#br-auth-005-otp-codes-are-treated-as-passwords)                  | OTP codes are treated as passwords                   |
| <a id="br-auth-006"></a>[BR-AUTH-006](../07_Business_Rules.md#br-auth-006-sessions-are-host-only)                              | Sessions are host-only                               |

See also: [Authentication module](../Modules/Authentication.md).
