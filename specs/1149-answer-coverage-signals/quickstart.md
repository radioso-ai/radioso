# Verification Quickstart

1. Configure a controlled retrieval corpus with related courses but no attendance
   rule. A cited answer records `unanswered` / `insufficient_evidence`, is
   composed with that limit, and presents `coverage_unanswered`.
2. Verify an explicit negative records `answered`, partial evidence records
   `partial` / `coverage_partial`, ambiguity records `unclear` /
   `coverage_unclear`, and malformed producer output is non-triggering with
   `coverage_unavailable` rather than a refusal.
3. Add one coverage directive and one eligible routine criterion. Verify their
   recorded decisions occur before visitor streaming, do not bypass confirmation,
   and repeat delivery is suppressed.
4. Inspect live debug and history: retrieval/citations, coverage, and decision
   trace remain separate. Each decision carries the assessment request and
   target message IDs, with a routine execution ID only after activation.
5. Seed two conversations at the recurrence threshold and verify Pulse counts,
   eligible recommendation, evidence navigation, routine linkage, and a mixed
   legacy report.
