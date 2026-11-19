'use client';

import React, { createContext, useContext, useState, useEffect, useRef, ReactNode, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { authApi } from '../api/authService';
import {
  AuthContextValue,
  AuthState,
  LoginCredentials,
  RegisterData,
  User,
} from '../types/auth';
import { useAuthStore } from '../store/authStore';
import { getErrorMessage } from '../utils/errorHandler';
import { AppError } from '../utils/errorHandler';
import {
  NormalizedAuthError,
} from '@/lib/normalizeAuthError';

/**
 * Auth Context
 */
const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * Auth Provider Props
 */
interface AuthProviderProps {
  children: ReactNode;
}

/**
 * Auth Provider Component
 * Manages global authentication state and provides auth methods
 */
export function AuthProvider({ children }: AuthProviderProps) {
  const pathname = usePathname();
  const setStoreUser = useAuthStore((s) => s.setUser);
  const storeLogout = useAuthStore((s) => s.logout);
  const isDevBypassEnabled =
    process.env.NODE_ENV === "development" &&
    process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH === "true";

  const [state, setState] = useState<AuthState>({
    user: null,
    isAuthenticated: false,
    isLoading: true,
    error: null,
    isSessionExpired: false,
  });

  const isolateAccountState = useCallback((accountId: string | null) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("xconfess:account-change", {
        detail: { accountId },
      }),
    );
    const accountStateKeys = [
      "xconfess_scroll_positions",
      "xconfess_search_history",
      "xconfess_drafts",
      "xconfess.pendingConfession.v1",
      "xconfess_account_settings",
    ];
    accountStateKeys.forEach((key) => window.localStorage.removeItem(key));
    window.localStorage.removeItem("xconfess-auth");
    window.sessionStorage.removeItem("xconfess_scroll_positions");
  }, []);

  // Guard against concurrent checkAuth calls (race-condition fix)
  const checkInProgress = useRef(false);

  /**
   * Handle TERMINAL auth errors: clear session and redirect to login.
   * TERMINAL errors mean the session is definitely invalid and cannot be recovered.
   */
  const handleTerminalAuthError = useCallback((error: AppError) => {
    // Check if this is a normalized TERMINAL auth error
    const normalized = (error.details as any)?.normalized as NormalizedAuthError | undefined;
    
    if (normalized?.type === "TERMINAL") {
      isolateAccountState(null);
      setStoreUser(null);
      storeLogout();
      setState({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
        isSessionExpired: true,
      });
    }
  }, [setStoreUser, storeLogout, isolateAccountState]);

  /**
  * Check if user is authenticated by validating token with backend.
  * Uses a ref-based mutex to prevent concurrent calls from racing and
  * causing state oscillation (e.g., loading → authenticated → loading).
  */
  const checkAuth = useCallback(async (): Promise<void> => {
    if (isDevBypassEnabled) {
      const mockRole = process.env.NEXT_PUBLIC_DEV_MOCK_ROLE || "user";
      const mockUser = {
        id: "dev-user",
        username: "dev",
        email: "dev@example.com",
        role: mockRole as "user" | "admin",
      };

      setStoreUser(mockUser as never);
      isolateAccountState(mockUser.id);
      setState({
        user: mockUser as never,
        isAuthenticated: true,
        isLoading: false,
        error: null,
        isSessionExpired: false,
      });
      return;
    }

    // Prevent concurrent check calls from racing
    if (checkInProgress.current) {
      return;
    }
    checkInProgress.current = true;

    try {
      const user = await authApi.getCurrentUser();
      isolateAccountState(user.id);
      setStoreUser(user);
      setState({
        user,
        isAuthenticated: true,
        isLoading: false,
        error: null,
        isSessionExpired: false,
      });
    } catch (error) {
      // Handle TERMINAL auth errors (invalid session, forbidden, etc.)
      if (error instanceof AppError) {
        handleTerminalAuthError(error);
      } else {
        // Not authenticated or session expired
        isolateAccountState(null);
        setStoreUser(null);
        setState({
          user: null,
          isAuthenticated: false,
          isLoading: false,
          error: null, // Don't show error for initial check
          isSessionExpired: false,
        });
      }
    } finally {
      checkInProgress.current = false;
    }
  }, [isDevBypassEnabled, setStoreUser, handleTerminalAuthError, isolateAccountState]);

  //   Check authentication status on mount

  useEffect(() => {
    // Public wallet-first pages do not need a session request. Authentication
    // is resolved only when entering the admin surface.
    if (!pathname.startsWith('/admin')) {
      setState((prev) => ({ ...prev, isLoading: false }));
      return;
    }

    // Wrap async call in IIFE to avoid synchronous setState in effect
    (async () => {
      await checkAuth();
    })();
  }, [checkAuth, pathname]);

  //  Login user with credentials

  const login = async (credentials: LoginCredentials): Promise<User> => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      const response = await authApi.login(credentials);

      // User data is now managed in the store and state
      // Token is in the HttpOnly cookie
      isolateAccountState(response.user.id);
      setStoreUser(response.user);

      setState({
        user: response.user,
        isAuthenticated: true,
        isLoading: false,
        error: null,
        isSessionExpired: false,
      });
      return response.user;
    } catch (error) {
      // Handle TERMINAL auth errors (invalid credentials, etc.)
      if (error instanceof AppError) {
        handleTerminalAuthError(error);
      }
      
      setState({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        error: getErrorMessage(error),
        isSessionExpired: false,
      });
      throw error;
    }
  };


  //  * Register new user and auto-login


  const register = async (data: RegisterData): Promise<void> => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      await authApi.register(data);

      // Auto-login after successful registration
      await login({ email: data.email, password: data.password });
    } catch (error) {
      setState({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        error: getErrorMessage(error),
        isSessionExpired: false,
      });
      throw error;
    }
  };


  // Logout user and clear auth data

  const logout = (): void => {
    // Fire-and-forget the session cookie deletion, but clear local state
    // immediately so AuthGuard can react without waiting for the network.
    authApi.logout().catch(() => {});
    isolateAccountState(null);
    storeLogout();
    setState({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
      isSessionExpired: false,
    });
  };

  const value: AuthContextValue = {
    ...state,
    login,
    register,
    logout,
    checkAuth,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}


//  Custom hook to use auth context
//  returns Auth context value
//  throws Error if used outside AuthProvider

export function useAuthContext(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuthContext must be used within an AuthProvider');
  }
  return context;
}

/** @deprecated Use `useAuthContext` instead */
export const useAuth = useAuthContext;
