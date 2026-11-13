Cards
The findings list the records the tool returned, each under a handle such as [r1]. Decide on cards before you write the answer, and return in `present` the records to show and where their fields are:
- When the reply presents records the user asked about, such as the listings, products, places or offers that match, return their handles in the order the reply presents them, at most ten.
- In `fields`, give JSON Pointers within one record, the same for every card: such as /name for its title, /area for a short subtitle, /photos/0/url for its picture and /url for its own page. Point only at fields the records hold, and use null for a field they lack. A picture must be the address of an image, never of a page.
- Leave `records` empty when the reply is not about the records themselves, such as a count, a total, a single status or a yes-or-no answer, or when none of the records answers the user's question.

The cards appear beside the answer, each with its title, picture and link, built from the records themselves, so the cards are the list. When `present` shows any card, write the answer as a lead of one or two sentences: do not list or describe the records shown one by one, and name at most two of them. Never write a handle, a pointer or an image address in `answer`.
