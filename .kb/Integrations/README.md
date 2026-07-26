# Integrations/

**Every external integration in this repository is a stub.** The adapters fall
back to a console implementation when the key is blank, and every key is blank.

The consolidated view, including what each integration will need when it is
wired, is [`../13_Integration_Guide.md`](../13_Integration_Guide.md).

| Integration                 | Env prefix                    | State                                            |
| --------------------------- | ----------------------------- | ------------------------------------------------ |
| SMS — MSG91                 | `SMS_*`                       | `console`. Hard-blocked on TRAI DLT registration |
| WhatsApp — Meta Cloud / BSP | `WHATSAPP_*`                  | `console`. Blocked on template approval          |
| Email — AWS SES             | `EMAIL_*`, `SES_*`            | `console`. Mailpit serves local dev              |
| Payments — Razorpay         | `RAZORPAY_*`                  | Not integrated. No account yet                   |
| Object storage — S3         | `S3_*`                        | Not integrated. `StoredFile` model only          |
| Errors — Sentry             | `SENTRY_DSN`                  | Not integrated                                   |
| Traces — OpenTelemetry      | `OTEL_EXPORTER_OTLP_ENDPOINT` | Not integrated                                   |
| ABDM / ABHA                 | —                             | Schema hooks only; explicitly a later phase      |

One file per integration will be added here as each is built. Adding a stub file
now would be documentation of something that does not exist.
