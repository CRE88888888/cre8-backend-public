# Official-source fixtures (#159)

Recorded with unauthenticated, read-only GETs on 2026-11-20. XML feeds retain a small set of complete items/entries; JSON submissions retain recent 8-K/Form 4 rows and metadata; FRED keeps its last five rows. No authentication headers are recorded.

- Fed: `https://www.federalreserve.gov/feeds/press_monetary.xml`
- BEA: `https://apps.bea.gov/rss/rss.xml`
- BLS v1: CUSR0000SA0, CES0000000001, LNS14000000
- Treasury: daily_treasury_yield_curve XML, year 2026
- FRED: fredgraph.csv, DTWEXBGS
- SEC: company_tickers.json and CIK0000320193 submissions (reduced to selected fields/rows)

Strategy backend GET returned 403. The HTML files are explicitly structural examples informed by the official archive web-reader result, not recorded successful backend responses. Its live collector remains unverified until the source allows access; errors must stay isolated. Form 4 coverage is issuer recent submissions only, not a complete insider transaction feed.
