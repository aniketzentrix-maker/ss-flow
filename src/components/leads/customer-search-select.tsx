"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";

export type CustomerSearchOption = {
  id: string;
  name: string;
  code?: string;
  contactPerson?: string;
  companyName?: string;
  phone?: string;
  email?: string;
};

type CustomerSearchSelectProps = {
  value: string;
  onChange: (customerId: string) => void;
  customers: CustomerSearchOption[];
  placeholder?: string;
  newCustomerLabel?: string;
  className?: string;
  disabled?: boolean;
};

function normalize(value: string | undefined | null) {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function digitsOnly(value: string | undefined | null) {
  return (value ?? "").replace(/\D/g, "");
}

function customerLabel(customer: CustomerSearchOption) {
  return customer.code ? `${customer.code} — ${customer.name}` : customer.name;
}

function customerSearchHaystack(customer: CustomerSearchOption) {
  return normalize(
    [
      customer.code,
      customer.name,
      customer.contactPerson,
      customer.companyName,
      customer.phone,
      customer.email,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function matchesCustomerQuery(customer: CustomerSearchOption, query: string) {
  const q = normalize(query);
  if (!q) return true;

  if (customerSearchHaystack(customer).includes(q)) return true;

  const phoneDigits = digitsOnly(query);
  if (phoneDigits.length >= 3) {
    const customerPhone = digitsOnly(customer.phone);
    if (customerPhone.includes(phoneDigits)) return true;
  }

  return false;
}

export function CustomerSearchSelect({
  value,
  onChange,
  customers,
  placeholder = "Search customer by name, phone, or email…",
  newCustomerLabel = "New customer — enter details below",
  className = "",
  disabled = false,
}: CustomerSearchSelectProps) {
  const selectId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selected = useMemo(
    () => customers.find((row) => row.id === value) ?? null,
    [customers, value],
  );

  const filtered = useMemo(() => {
    if (!search.trim()) return customers;
    return customers.filter((customer) => matchesCustomerQuery(customer, search));
  }, [customers, search]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      const timer = window.setTimeout(() => searchInputRef.current?.focus(), 50);
      return () => window.clearTimeout(timer);
    }
    setSearch("");
  }, [isOpen]);

  function selectCustomer(customerId: string) {
    onChange(customerId);
    setIsOpen(false);
    setSearch("");
  }

  const triggerLabel = selected ? customerLabel(selected) : newCustomerLabel;

  return (
    <div ref={containerRef} className={`relative w-full ${className}`}>
      <button
        type="button"
        id={selectId}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label="Select customer"
        onClick={() => {
          if (!disabled) setIsOpen((open) => !open);
        }}
        className={`flex h-11 w-full items-center justify-between rounded-[10px] border border-border bg-card px-3 text-left text-sm text-foreground transition outline-none focus-visible:border-info focus-visible:ring-2 focus-visible:ring-info/25 ${
          disabled ? "cursor-not-allowed bg-muted/20 opacity-60" : "cursor-pointer hover:border-border/80"
        }`}
      >
        <span className={`truncate ${selected ? "font-medium text-foreground" : "text-muted/70"}`}>
          {triggerLabel}
        </span>
        <div className="flex shrink-0 items-center gap-1.5 pl-2 text-muted">
          {value && !disabled ? (
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear customer"
              onClick={(event) => {
                event.stopPropagation();
                selectCustomer("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  selectCustomer("");
                }
              }}
              className="rounded p-0.5 hover:bg-muted/40 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </span>
          ) : null}
          <ChevronDown className={`h-4 w-4 transition ${isOpen ? "rotate-180" : ""}`} />
        </div>
      </button>

      {isOpen ? (
        <div className="absolute z-40 mt-1 w-full overflow-hidden rounded-[12px] border border-border bg-card shadow-lg">
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={placeholder}
                className="h-10 w-full rounded-[8px] border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted/70 focus-visible:border-info focus-visible:ring-2 focus-visible:ring-info/25"
                aria-label="Search customers"
              />
            </div>
            <p className="mt-1.5 px-1 text-[11px] text-muted">
              Search by name, phone, email, or company
            </p>
          </div>

          <ul role="listbox" aria-labelledby={selectId} className="max-h-64 overflow-y-auto py-1">
            <li>
              <button
                type="button"
                role="option"
                aria-selected={!value}
                onClick={() => selectCustomer("")}
                className={`flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm transition hover:bg-muted/30 ${
                  !value ? "bg-info/5 text-foreground" : "text-foreground"
                }`}
              >
                <span className="min-w-0 flex-1 truncate font-medium">{newCustomerLabel}</span>
                {!value ? <Check className="h-4 w-4 shrink-0 text-info" /> : null}
              </button>
            </li>

            {filtered.length === 0 ? (
              <li className="px-3 py-4 text-center text-sm text-muted">No customers match “{search.trim()}”.</li>
            ) : (
              filtered.map((customer) => {
                const isSelected = customer.id === value;
                const secondary = [customer.phone, customer.email, customer.companyName]
                  .map((part) => part?.trim())
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <li key={customer.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => selectCustomer(customer.id)}
                      className={`flex w-full items-start gap-2 px-3 py-2.5 text-left text-sm transition hover:bg-muted/30 ${
                        isSelected ? "bg-info/5" : ""
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-foreground">
                          {customerLabel(customer)}
                        </span>
                        {secondary ? (
                          <span className="mt-0.5 block truncate text-xs text-muted">{secondary}</span>
                        ) : null}
                      </span>
                      {isSelected ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-info" /> : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
