'use client'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ApiValueType } from '@/lib/api-connections'
import { API_VALUE_TYPES } from './api-request-skill-model'

export function ApiValueTypeSelect({ value, label, onChange }: {
  value: ApiValueType
  label: string
  onChange: (value: ApiValueType) => void
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as ApiValueType)}>
      <SelectTrigger aria-label={label} className="h-9"><SelectValue /></SelectTrigger>
      <SelectContent>
        {API_VALUE_TYPES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}
