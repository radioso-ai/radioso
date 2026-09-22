import Image from 'next/image'
import { Spinner } from '@radioso/ui/spinner'

import { cn } from '@/lib/utils'

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
        src="/radioso-icon.svg"
        alt=""
        aria-hidden="true"
        width={32}
        height={32}
        loading="eager"
        className={cn('h-8 w-8 animate-[spin_2.4s_linear_infinite] rounded-lg object-cover', imageClassName)}
      />
    </div>
  )
}

export { Spinner, LogoSpinner }
