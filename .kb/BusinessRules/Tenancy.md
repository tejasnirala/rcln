# Business rules — Tenancy

Rule text lives in [`07_Business_Rules.md`](../07_Business_Rules.md); this file is the
per-module index the [module catalog](../Modules/Tenancy.md) links into.

| Rule                                                                                                                                   | Statement                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| <a id="br-ten-001"></a>[BR-TEN-001](../07_Business_Rules.md#br-ten-001-registration-is-one-transaction-or-nothing)                     | Registration is one transaction or nothing                     |
| <a id="br-ten-002"></a>[BR-TEN-002](../07_Business_Rules.md#br-ten-002-an-unknown-tenant-is-404-never-403)                             | An unknown tenant is 404, never 403                            |
| <a id="br-ten-003"></a>[BR-TEN-003](../07_Business_Rules.md#br-ten-003-reserved-subdomains-cannot-be-claimed)                          | Reserved subdomains cannot be claimed                          |
| <a id="br-ten-004"></a>[BR-TEN-004](../07_Business_Rules.md#br-ten-004-slug-availability-is-an-oracle-and-is-rate-limited-accordingly) | Slug availability is an oracle and is rate-limited accordingly |
| <a id="br-ten-005"></a>[BR-TEN-005](../07_Business_Rules.md#br-ten-005-tenant-context-is-transaction-local)                            | Tenant context is transaction-local                            |

See also: [Tenancy module](../Modules/Tenancy.md).
