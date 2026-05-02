import Image from 'next/image'
import { Loader2Icon } from 'lucide-react'

import { cn } from '../../lib/utils'

function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn('size-4 animate-spin', className)}
      {...props}
    />
  )
}

function LogoSpinner({
  className,
  imageClassName,
  ...props
}: React.ComponentProps<'div'> & { imageClassName?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn('flex items-center justify-center', className)}
      {...props}
    >
      <Image
        src="/radioso-logo.png"
        alt=""
        aria-hidden="true"
        width={32}
        height={32}
        className={cn('h-8 w-8 animate-[spin_2.4s_linear_infinite] rounded-lg object-cover', imageClassName)}
      />
    </div>
  )
}

export { Spinner, LogoSpinner }
