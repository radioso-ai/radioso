# @radioso/census

Census clusters `(id, text, vector)` triples into topic groups. Given a set
of items and a target cluster size, it returns clusters with a centroid,
a radius, and the member ids that belong to them, plus the ids that did
not meet the minimum cluster size.

Census also carries a topic's identity from one analysis to the next.
`matchTopicIdentities` compares a stored set of topics against a fresh set
of clusters and classifies each relationship as survived, split, merged,
emerged, or dissolved, so a caller can say whether a topic is growing
rather than only what the current run found. It matches on membership
overlap, and falls back to centroid similarity — flagged as the weaker
path — when the two runs share no members.

Census does not compute embeddings and does not name clusters. Both are
the caller's responsibility, passed in as data or as functions where a
future module needs one. The library has no knowledge of any embedding
provider, any LLM, or any naming scheme.

Census has no I/O. It does not read files, call a network, or touch a
database. It takes plain data in and returns plain data out.

Census has zero runtime dependencies. `package.json` carries no
`dependencies` block, only `devDependencies` for building and testing.
Anything the algorithms need is implemented inside this package.
