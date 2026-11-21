"use client";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ContextVariable } from "@/lib/api-types";

// An option key starts with a letter, so this never names one.
const NOT_SET = "__not_set__";

/**
 * The sample value of one attribute in a private test, entered the way its type is written: JSON as
 * text, a Choice as one of its active options, shown by label and sent as its key, anything else as
 * free text. `value` is the raw entry the sample validation parses.
 */
export function TestValueInput({
  id,
  variable,
  value,
  onChange,
}: {
  id: string;
  variable: ContextVariable;
  value: string;
  onChange: (value: string) => void;
}) {
  if (variable.valueType === "json") {
    return (
      <Textarea id={id} value={value} placeholder="Valid JSON" onChange={(event) => onChange(event.target.value)} />
    );
  }
  if (variable.valueType === "enum") {
    const options = (variable.options ?? []).filter((option) => !option.archived);
    return (
      <Select value={value || NOT_SET} onValueChange={(next) => onChange(next === NOT_SET ? "" : next)}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NOT_SET}>Not set</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.key} value={option.key}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  return <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} />;
}
