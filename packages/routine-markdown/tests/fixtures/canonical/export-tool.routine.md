---
grammar: 1
name: Refund check
trigger: customer asks for a refund
reentry: always
export: complete,handoff -> 55555555-5555-4555-8555-555555555555
vars: amount:number
---
# Check eligibility
Call the refund tool #refund.check[in amount=@amount, locale=ctx.page_locale; out status=@refund_status]
[if refund_status = approved] -> end
[outcome failed] -> handoff
