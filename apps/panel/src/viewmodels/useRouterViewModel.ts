import { useEffect, useState, useCallback } from "react";
import { DEFAULT_PAGE, parseHashPage, type PageId } from "../services/routes.js";

export function useRouterViewModel() {
  const [currentPage, setCurrentPage] = useState<PageId>(() => {
    if (typeof window !== "undefined" && window.location.hash) {
      return parseHashPage(window.location.hash);
    }
    return DEFAULT_PAGE;
  });

  useEffect(() => {
    function handleHashChange() {
      setCurrentPage(parseHashPage(window.location.hash));
    }
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const navigate = useCallback((page: PageId) => {
    setCurrentPage(page);
    if (typeof window !== "undefined") {
      window.location.hash = page === DEFAULT_PAGE ? "" : `#/${page}`;
    }
  }, []);

  return {
    currentPage,
    navigate,
  };
}
