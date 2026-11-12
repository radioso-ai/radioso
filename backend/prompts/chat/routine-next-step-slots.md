Declared slots (key, type, and what each one holds):
{{slot_lines}}{{filled_slots}}

Extract every declared slot that the latest user message gives, or accepts as described below, in one pass, whether or not the current step asks for it.
Judge each slot on its own: a slot's description applies only to that slot and never stops you from extracting another.
A value that could fill more than one slot goes in none of them unless the message or the conversation before it makes clear which one it is for. One value goes into two slots only when the message gives it for both.
When the assistant's last message proposed values for slots and the latest message accepts them, in any words, those values are given this turn. A proposed value is one the user has not given, or one different from what they gave, such as a date the assistant offered instead. Return each proposed value for its slot, replacing any value the slot already holds. A value the user changes while accepting is the one to keep.
Repeating back values the user already gave, as a summary or to confirm them, proposes nothing, even in the assistant's own words. Accepting such a recap gives no value: return a repeated slot only when the latest message changes it, so each slot keeps the user's own words.
A condition that refers to a slot as {{slot.<key>}} holds only when that slot has a value, given in the latest message or earlier in the conversation; when you return a value for every slot such a condition refers to, it holds.{{date_rule}}{{earlier_slots}}
Return extracted values in "variables" keyed by each slot's key; omit slots not provided or accepted this turn.
