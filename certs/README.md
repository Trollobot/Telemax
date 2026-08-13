# Russian Trusted CA bundle

`russian_trusted_root_ca.crt` and `russian_trusted_sub_ca.crt` are the official
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
