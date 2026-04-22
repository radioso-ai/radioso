import { Footer, Layout, Navbar } from 'nextra-theme-docs'
import { Head } from 'nextra/components'
import { getPageMap } from 'nextra/page-map'

import { Logo } from '@/components/logo'
import { site } from '@/lib/site'
import 'nextra-theme-docs/style.css'

export default async function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Head color={{ hue: 154, saturation: 44 }} />
      <Layout
        navbar={<Navbar logo={<Logo />} />}
        pageMap={await getPageMap('/')}
        editLink={null}
        footer={
          <Footer>
            <div className="docs-footer">
              <span>Radioso Docs</span>
              <a href={site.appUrl}>Open app</a>
            </div>
          </Footer>
        }
      >
        {children}
      </Layout>
    </>
  )
}
