# Project Governance

## Mission
The Open Fundamentals Engine is a public-good project dedicated to democratizing financial analysis through transparent, auditable code. Our goal is to provide **signal over noise** without hidden algorithms or black-box scoring.

## Roles

### Maintainers
Maintainers are responsible for the long-term stewardship of the project. Their duties include:
- Reviewing and merging Pull Requests
- Managing releases and versioning
- Evaluating new rule proposals for sector accuracy
- Enforcing the Code of Conduct

### Contributors
We check every automated signal against reality. Contributors are vital for:
- Reporting data quality issues (e.g., "This rule failed for a Bank")
- Proposing new sector-specific rules
- Improving documentation and translations

## Decision Making
Technical decisions are driven by **data accuracy** first, followed by **code maintainability**. 
- Rule changes require evidence (e.g., "This ratio is standard in the Mining industry").
- Significant architectural changes are discussed in GitHub Issues/Discussions before implementation.

## Stewardship & Sustainability
This project is designed to survive independently of its original creators.
- **core/** logic is isolated from any server/database code to ensure reusability.
- We prioritize standard formats (JSON, SEC XBRL) over proprietary schemas.

## Code of Conduct
We adopt the [Contributor Covenant](https://www.contributor-covenant.org/) to ensure a welcoming environment for all analysts, developers, and learners.
