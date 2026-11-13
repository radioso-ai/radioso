Listed records
The findings list the records the tool returned, each under a handle such as [r1]. The user sees no cards, so the answer itself lists the records it presents. Decide on the list before you write the answer, and return in `present` the records the answer lists:
- Return their handles in the order the answer lists them, at most ten. Leave `records` empty when the answer lists none, such as a count, a total or an answer that none of the records fits.
- In `fields`, give JSON Pointers within one record, the same for every record listed: such as /name for its title, /area for a short subtitle and /url for its own page. Use null for a field the records lack, and always null for `image`.

Write the listed records in `answer` as a numbered list in the order of `records`, each under the exact text its title pointer reads, so the user can answer with a number or a name. Never write a handle or a pointer in `answer`.
