import { LandingPage, LiveLab } from "./echo-maze";

type SearchParams = Record<string, string | string[] | undefined>;

function readParam(params: SearchParams | undefined, key: string) {
  const value = params?.[key];
  return Array.isArray(value) ? value[0] : value;
}

function isLiveLabEnabled(params: SearchParams | undefined) {
  const lab = readParam(params, "lab");
  return lab === "1" || lab === "true";
}

export default async function HomePage({
  searchParams,
}: {
  searchParams?: SearchParams | Promise<SearchParams>;
}) {
  const params = await Promise.resolve(searchParams ?? {});
  if (isLiveLabEnabled(params)) return <LiveLab />;
  return <LandingPage />;
}
