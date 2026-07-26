# Business rules — IAM

Rule text lives in [`07_Business_Rules.md`](../07_Business_Rules.md); this file is the
per-module index the [module catalog](../Modules/IAM.md) links into.

| Rule                                                                                                                         | Statement                                            |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| <a id="br-iam-001"></a>[BR-IAM-001](../07_Business_Rules.md#br-iam-001-permission-precedence-is-deny-grant-role-grant)       | Permission precedence is DENY > GRANT > role grant   |
| <a id="br-iam-002"></a>[BR-IAM-002](../07_Business_Rules.md#br-iam-002-a-null-branch-id-means-every-branch)                  | A NULL `branch_id` means every branch                |
| <a id="br-iam-003"></a>[BR-IAM-003](../07_Business_Rules.md#br-iam-003-you-cannot-grant-a-permission-you-do-not-hold)        | You cannot grant a permission you do not hold        |
| <a id="br-iam-004"></a>[BR-IAM-004](../07_Business_Rules.md#br-iam-004-an-org-wide-grant-requires-org-wide-reach)            | An org-wide grant requires org-wide reach            |
| <a id="br-iam-005"></a>[BR-IAM-005](../07_Business_Rules.md#br-iam-005-every-mutation-reads-its-row-first)                   | Every mutation reads its row first                   |
| <a id="br-iam-006"></a>[BR-IAM-006](../07_Business_Rules.md#br-iam-006-access-cache-must-be-invalidated-on-every-role-write) | Access cache must be invalidated on every role write |

See also: [IAM module](../Modules/IAM.md).
