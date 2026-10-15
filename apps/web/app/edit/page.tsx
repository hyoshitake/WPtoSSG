import { EditDashboard } from './edit-dashboard';
export default async function EditPage({ searchParams }: { searchParams: Promise<{ siteKey?: string }> }) {
  const { siteKey } = await searchParams;
  return (
    <main className="mx-auto max-w-7xl px-8 py-10">
      <h1 className="text-3xl font-semibold">編集</h1>
      <EditDashboard initialSiteKey={siteKey} />
    </main>
  );
}
