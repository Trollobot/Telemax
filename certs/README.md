# Russian Trusted CA bundle

`russian_trusted_root_ca.crt`, `russian_trusted_sub_ca.crt` and `russian_trusted_sub_ca_2024.crt` are the official
CA certificates from the Russian Ministry of Digital Development (Минцифры),
downloaded from the well-known public distribution at `gu-st.ru` (the same
files used broadly for accessing gosuslugi.ru and other `.ru` government-linked
HTTPS services).

Needed because MAX's TLS certificate (`*.oneme.ru`) chains through this CA,
which isn't in any standard public trust store (Mozilla/Debian/etc.) — without
it, `rejectUnauthorized: true` fails with "unable to get local issuer
certificate" (confirmed live on first Docker deploy, 2026-08-08).

Before trusting these files, their subject/issuer fields were checked against
the actual certificate chain MAX presents (`openssl s_client -connect
155.212.204.150:443 -servername api2.oneme.ru`) — the sub CA's issuer matches
the root CA's subject, and the root CA's issuer matches MAX leaf cert's issuer
field exactly.

## Scope of trust

These CAs are deliberately NOT installed system-wide (`update-ca-certificates`)
or process-wide (`NODE_EXTRA_CA_CERTS`): either would make every TLS connection
from the container — Telegram Bot API, GitHub — accept certificates issued by a
state CA, which is exactly the MITM exposure such a CA enables. Instead,
`src/max/ca.ts` applies these PEMs only to the two
places that actually talk to MAX: the raw TCP client (`tls.connect` in
`src/max/client.ts`) and the CDN up/downloads (`maxFetch`). Everything else is
verified against Node's bundled Mozilla roots only.

## Built into the bridge

Since 1.4.4 the bridge does not read this folder at run time: `scripts/gen-russian-ca.mjs` turns
every `*.crt` here into `src/max/russianCa.generated.ts`, which is bundled with the code, and
`tests/certs.test.ts` fails while the two differ. Read from disk, a bridge started from another
folder or a copy missing these files could not reach MAX at all («unable to get local issuer
certificate», 2026-11-22). After changing anything here, run `node scripts/gen-russian-ca.mjs`.

## 2024 sub CA

MAX's chain moved to a newer «Russian Trusted Sub CA» (issued 2024-07-15, valid to 2029-07-19,
SHA-256 `21:55:78:50:…:88:A3:F2`). `russian_trusted_sub_ca_2024.crt` is the official file from
`https://gu-st.ru/content/lending/russian_trusted_sub_ca_2024_pem.crt`, checked on 2026-11-22: same
fingerprint as the intermediate `api2.oneme.ru` presents, and `openssl verify` against the root here
says OK. The older sub CA (valid to 2027-03-06) is kept until it expires. The server sends its
intermediate itself, so the root alone already verifies MAX today; the sub CAs are for a server
that ever leaves its intermediate out.
