"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "./AuthProvider";

const HIDE_NAVBAR_ROUTES = ["/login", "/signup"];

export function NavBar() {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  async function handleLogout() {
    await logout();
    // replace, not push — once logged out, Back should not return the
    // user to an authenticated page in history.
    router.replace("/login");
  }

  if (HIDE_NAVBAR_ROUTES.includes(pathname)) {
    return null;
  }

  return (
    <nav className="navbar">
      <div className="container navbar-inner">
        <Link href="/" className="logo">
          <span className="logo-mark">✉</span>
          <span className="logo-name">EmailFlow</span>
        </Link>
        <div className="navbar-links">
          {loading ? null : user ? (
            <>
              <Link href="/contacts">Contacts</Link>
              <Link href="/tags">Tags</Link>
              <Link href="/audiences">Audiences</Link>
              <Link href="/campaigns">Campaigns</Link>
              <span className="navbar-email">{user.email}</span>
              <button className="button button-secondary" onClick={handleLogout}>
                Log out
              </button>
            </>
          ) : (
            <>
              <Link href="/login">Log in</Link>
              <Link href="/signup">Sign up</Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}