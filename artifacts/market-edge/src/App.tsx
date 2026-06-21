import { useEffect, useRef } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from 'wouter';
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import Home from "./pages/home";
import Markets from "./pages/markets";
import Builder from "./pages/builder";
import Portfolio from "./pages/portfolio";
import ComboDetail from "./pages/combo-detail";
import { Layout } from "./components/layout";
import { BuilderProvider } from "./lib/builder-context";
import { AlertsNotifier } from "./components/alerts-notifier";

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

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/builder" />
      </Show>
      <Show when="signed-out">
        <Home />
      </Show>
    </>
  );
}

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
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
      signUpUrl={`${basePath}/sign-up`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <AlertsNotifier />
        <BuilderProvider>
          <Switch>
            <Route path="/" component={HomeRedirect} />
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />
            
            <Route path="/markets">
              <Layout><Markets /></Layout>
            </Route>
            <Route path="/builder">
              <Layout><Builder /></Layout>
            </Route>
            <Route path="/portfolio">
              <Layout>
                <Show when="signed-in"><Portfolio /></Show>
                <Show when="signed-out"><Redirect to="/sign-in" /></Show>
              </Layout>
            </Route>
            <Route path="/combo/:id">
              {(params) => (
                <Layout>
                  <Show when="signed-in"><ComboDetail id={params.id} /></Show>
                  <Show when="signed-out"><Redirect to="/sign-in" /></Show>
                </Layout>
              )}
            </Route>
            
            <Route>
              <Layout>
                <div className="flex h-full items-center justify-center p-8">
                  <h1 className="text-2xl font-bold">404 Not Found</h1>
                </div>
              </Layout>
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
