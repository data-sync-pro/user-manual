import {
  AuthService,
  Component,
  Router,
  RouterOutlet,
  __async,
  bootstrapApplication,
  connectAuthEmulator,
  connectFirestoreEmulator,
  getAuth,
  getFirestore,
  initializeApp,
  inject,
  provideAuth,
  provideFirebaseApp,
  provideFirestore,
  provideRouter,
  provideZoneChangeDetection,
  setClassMetadata,
  withInMemoryScrolling,
  ɵsetClassDebugInfo,
  ɵɵdefineComponent,
  ɵɵelement
} from "./chunk-QHPMAYQA.js";

// src/app/core/guards.ts
var guestGuard = () => __async(null, null, function* () {
  const auth = inject(AuthService);
  const router = inject(Router);
  const user = yield auth.authReady();
  if (user) {
    router.navigateByUrl("/dashboard");
    return false;
  }
  return true;
});
var requiredGuard = () => __async(null, null, function* () {
  const auth = inject(AuthService);
  const router = inject(Router);
  const user = yield auth.authReady();
  if (!user) {
    router.navigateByUrl("/login");
    return false;
  }
  return true;
});
var adminGuard = () => __async(null, null, function* () {
  const auth = inject(AuthService);
  const router = inject(Router);
  const user = yield auth.authReady();
  if (!user) {
    router.navigateByUrl("/login");
    return false;
  }
  if (!auth.isAdmin()) {
    router.navigateByUrl("/dashboard");
    return false;
  }
  return true;
});

// src/app/app.routes.ts
var routes = [
  { path: "", pathMatch: "full", redirectTo: "login" },
  {
    path: "login",
    canActivate: [guestGuard],
    loadComponent: () => import("./chunk-RQ7627SR.js").then((m) => m.LoginComponent)
  },
  {
    path: "dashboard",
    canActivate: [requiredGuard],
    loadComponent: () => import("./chunk-7NDBZC73.js").then((m) => m.DashboardComponent)
  },
  {
    path: "deal-registration",
    canActivate: [requiredGuard],
    loadComponent: () => import("./chunk-VXCFJS4N.js").then((m) => m.DealRegistrationComponent)
  },
  {
    path: "admin",
    canActivate: [adminGuard],
    loadComponent: () => import("./chunk-ODRQKWJ6.js").then((m) => m.AdminComponent)
  },
  { path: "**", redirectTo: "login" }
];

// src/environments/environment.ts
var environment = {
  production: true,
  firebase: {
    apiKey: "demo-api-key",
    authDomain: "demo-partner-portal.firebaseapp.com",
    projectId: "demo-partner-portal"
  }
};

// src/app/app.config.ts
var useEmulator = () => typeof location !== "undefined" && (location.hostname === "localhost" || location.hostname === "127.0.0.1");
var appConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withInMemoryScrolling({ scrollPositionRestoration: "top" })),
    provideFirebaseApp(() => initializeApp(environment.firebase)),
    provideAuth(() => {
      const auth = getAuth();
      if (useEmulator()) {
        connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
      }
      return auth;
    }),
    provideFirestore(() => {
      const db = getFirestore();
      if (useEmulator()) {
        connectFirestoreEmulator(db, "127.0.0.1", 8080);
      }
      return db;
    })
  ]
};

// src/app/app.component.ts
var AppComponent = class _AppComponent {
  static \u0275fac = function AppComponent_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _AppComponent)();
  };
  static \u0275cmp = /* @__PURE__ */ \u0275\u0275defineComponent({ type: _AppComponent, selectors: [["app-root"]], decls: 1, vars: 0, template: function AppComponent_Template(rf, ctx) {
    if (rf & 1) {
      \u0275\u0275element(0, "router-outlet");
    }
  }, dependencies: [RouterOutlet], encapsulation: 2 });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(AppComponent, [{
    type: Component,
    args: [{
      selector: "app-root",
      standalone: true,
      imports: [RouterOutlet],
      template: "<router-outlet></router-outlet>"
    }]
  }], null, null);
})();
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && \u0275setClassDebugInfo(AppComponent, { className: "AppComponent", filePath: "src/app/app.component.ts", lineNumber: 10 });
})();

// src/main.ts
bootstrapApplication(AppComponent, appConfig).catch((err) => console.error(err));
//# sourceMappingURL=main.js.map
