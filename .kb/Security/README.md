# Security/

Topic-level security notes. The consolidated model is
[`../08_Security_Model.md`](../08_Security_Model.md); these files hold the detail
that would swamp it.

| File                                       | Covers                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| [Tenant_Isolation.md](Tenant_Isolation.md) | The three layers, the policy flavours, and how to verify isolation holds |
| [Threat_Model.md](Threat_Model.md)         | Assets, actors, attack surfaces, and what is and is not mitigated        |

Related, elsewhere:

- [ADR-0003](../Architecture/decisions/0003-rls-enable-not-force.md) — why ENABLE and not FORCE
- [ADR-0004](../Architecture/decisions/0004-composite-foreign-keys.md) — composite FKs
- [ADR-0005](../Architecture/decisions/0005-tenant-scoped-prisma-client.md) — the tenant-scoped client
- [ADR-0011](../Architecture/decisions/0011-own-membership-identity-bootstrap.md) — the one deliberate RLS widening
- [`../Architecture/PITFALLS.md`](../Architecture/PITFALLS.md) — several entries are security-relevant
