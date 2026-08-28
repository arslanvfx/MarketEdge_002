import { useEffect, useRef, lazy, Suspense } from "react";
import { ClerkProvider, SignIn, useClerk, useAuth } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from 'wouter';
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import NotFound from "./pages/not-found";
import Home from "./pages/home";
import Markets from "./pages/markets";
import Builder from "./pages/builder";
import Portfolio from "./pages/portfolio";
import ComboDetail from "./pages/combo-detail";
import SmartPicks from "./pages/picks";
import Predictor from "./pages/predictor";
import BotDashboard from "./pages/bot-dashboard";
const Dashboard2 = lazy(() => import("./pages/dashboard2"));
import { Layout } from "./components/layout";
import { BuilderProvider } from "./lib/builder-context";
import { AlertsNotifier } from "./components/alerts-notifier";

const StockScanner = lazy(() => import("./pages/stocks/scanner"));
const StockResearch = lazy(() => import("./pages/stocks/research"));
const StockWatchlist = lazy(() => import("./pages/stocks/watchlist"));
const StockBot = lazy(() => import("./pages/stocks/bot"));
const StockHistory = lazy(() => import("./pages/stocks/history"));
const StockPerformance = lazy(() => import("./pages/stocks/performance"));

function StocksFallback() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      Loading…
    </div>
  );
}

const queryClient = new QueryClient();
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || "/" : path;
}

if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY');

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(199 89% 48%)",
    colorBackground: "hsl(222 47% 11%)",
    colorInput: "hsl(216 34% 17%)",
    colorNeutral: "hsl(216 34% 17%)",
    colorText: "hsl(213 31% 91%)",
    fontFamily: "Inter, sans-serif",
  },
  elements: {
    cardBox: "w-[440px] max-w-full overflow-hidden bg-[#0d1321] border border-[#1d283a] rounded-xl shadow-2xl",
    card: "!bg-transparent !shadow-none",
    headerTitle: "text-white",
    headerSubtitle: "text-gray-400",
    formFieldLabel: "text-gray-300",
    formFieldInput: "bg-[#1d283a] border-[#2d3a50] text-white",
    footerActionText: "text-gray-400",
    footerActionLink: "text-[#0ea5e9] hover:text-[#38bdf8]",
    socialButtonsBlockButton: "border-[#2d3a50] hover:bg-[#1d283a] text-white",
    socialButtonsBlockButtonText: "text-white",
    dividerText: "text-gray-500",
    dividerLine: "bg-[#2d3a50]",
    formButtonPrimary: "bg-[#0ea5e9] hover:bg-[#0284c7] text-white",
  }
};

// All routes inside RequireAuth are only reachable when signed in,
// so HomeRedirect can unconditionally send to /builder.
function HomeRedirect() {
  return <Redirect to="/builder" />;
}

/**
 * Global auth gate. Wraps every route except /sign-in and /sign-up.
 * While Clerk is initialising (isLoaded=false) we render nothing to avoid
 * a flash-redirect. Once loaded, any unauthenticated visitor is sent to
 * /sign-in with their intended destination preserved as redirect_url so
 * Clerk returns them there after login.
 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  const [location] = useLocation();

  if (!isLoaded) return null;

  if (!isSignedIn) {
    const dest = encodeURIComponent(`${basePath}${location}`);
    return <Redirect to={`/sign-in?redirect_url=${dest}`} />;
  }

  return <>{children}</>;
}

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignIn routing="path" path={`${basePath}/sign-in`} />
    </div>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <AlertsNotifier />
        <BuilderProvider>
          <Switch>
            {/* Sign-in is exempt from the auth gate — it must
                render before RequireAuth so there is no redirect loop.
                Sign-up is disabled; redirect to sign-in. */}
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={() => <Redirect to="/sign-in" />} />

            {/* Every other route requires authentication. */}
            <Route>
              <RequireAuth>
                <Switch>
                  <Route path="/" component={HomeRedirect} />

                  <Route path="/markets">
                    <Layout><Markets /></Layout>
                  </Route>
                  <Route path="/picks">
                    <Layout><SmartPicks /></Layout>
                  </Route>
                  <Route path="/predictor">
                    <Layout><Predictor /></Layout>
                  </Route>
                  <Route path="/builder">
                    <Layout><Builder /></Layout>
                  </Route>
                  <Route path="/bot">
                    <Layout><BotDashboard /></Layout>
                  </Route>
                  <Route path="/dashboard-2">
                    <Layout><Suspense fallback={<StocksFallback />}><Dashboard2 /></Suspense></Layout>
                  </Route>
                  <Route path="/portfolio">
                    <Layout><Portfolio /></Layout>
                  </Route>
                  <Route path="/combo/:id">
                    {(params) => (
                      <Layout><ComboDetail id={params.id} /></Layout>
                    )}
                  </Route>

                  <Route path="/stocks" component={() => <Redirect to="/stocks/scanner" />} />
                  <Route path="/stocks/scanner">
                    <Layout><Suspense fallback={<StocksFallback />}><StockScanner /></Suspense></Layout>
                  </Route>
                  <Route path="/stocks/research">
                    <Layout><Suspense fallback={<StocksFallback />}><StockResearch /></Suspense></Layout>
                  </Route>
                  <Route path="/stocks/watchlist">
                    <Layout><Suspense fallback={<StocksFallback />}><StockWatchlist /></Suspense></Layout>
                  </Route>
                  <Route path="/stocks/performance">
                    <Layout><Suspense fallback={<StocksFallback />}><StockPerformance /></Suspense></Layout>
                  </Route>
                  <Route path="/stocks/history">
                    <Layout><Suspense fallback={<StocksFallback />}><StockHistory /></Suspense></Layout>
                  </Route>
                  <Route path="/stocks/bot">
                    <Layout><Suspense fallback={<StocksFallback />}><StockBot /></Suspense></Layout>
                  </Route>

                  <Route>
                    <NotFound />
                  </Route>
                </Switch>
              </RequireAuth>
            </Route>
          </Switch>
        </BuilderProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <TooltipProvider>
      <WouterRouter base={basePath}>
        <ClerkProviderWithRoutes />
      </WouterRouter>
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
