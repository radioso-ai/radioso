import { z } from 'zod'

export const emailAddressSchema = z.string().trim().email()

export const isValidEmailAddress = (value: string) => emailAddressSchema.safeParse(value).success
