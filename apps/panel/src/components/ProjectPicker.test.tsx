// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectPicker } from "./ProjectPicker.js";
import type { Project } from "../services/projects.js";

afterEach(cleanup);

const projects: readonly Project[] = [
  { project_id: "p1", name: "Satranç", type: "web", status: "running" },
  { project_id: "p2", name: "Todo", type: "api", status: "draft" },
];

const base = {
  projects,
  draft: { name: "", type: "web", budget: "5" },
  onDraft: () => undefined,
  onCreate: () => undefined,
  statusMessage: "",
  onSelect: () => undefined,
} as const;

describe("ProjectPicker", () => {
  it("projeleri adi ve turuyle listeler", () => {
    render(<ProjectPicker {...base} />);
    expect(screen.getByText("Satranç")).toBeTruthy();
    expect(screen.getByText(/web · p1/)).toBeTruthy();
  });

  it("projeye tiklaninca secimi bildirir", () => {
    const onSelect = vi.fn();
    render(<ProjectPicker {...base} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Todo"));
    expect(onSelect).toHaveBeenCalledWith("p2");
  });

  it("proje olustur dugmesi cagriyi iletir", () => {
    const onCreate = vi.fn();
    render(<ProjectPicker {...base} onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: /Proje oluştur/ }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("ad yazilinca taslagi gunceller", () => {
    const onDraft = vi.fn();
    render(<ProjectPicker {...base} onDraft={onDraft} />);
    fireEvent.change(screen.getByLabelText("Proje adı"), { target: { value: "Yeni" } });
    expect(onDraft).toHaveBeenCalledWith({ name: "Yeni" });
  });

  it("durum mesajini gosterir", () => {
    render(<ProjectPicker {...base} statusMessage="proje oluşturuldu" />);
    expect(screen.getByText("proje oluşturuldu")).toBeTruthy();
  });

  // docs/09 ui_audit: boş durum tasarlanmış olmalı.
  it("proje yokken bos durumu soyler", () => {
    render(<ProjectPicker {...base} projects={[]} />);
    expect(screen.getByText(/henüz proje yok/i)).toBeTruthy();
  });

  // "Proje yok" ile "liste alınamadı" AYNI ŞEY DEĞİLDİR: ikisini karıştırmak
  // kullanıcıya projelerini kaybettiğini düşündürür ve kopyasını açtırabilir.
  it("liste alinamadiginda bos durum yerine hatayi gosterir", () => {
    render(<ProjectPicker {...base} projects={[]} loadError="Proje listesi alınamadı" />);
    expect(screen.getByText("Proje listesi alınamadı")).toBeTruthy();
    expect(screen.queryByText(/henüz proje yok/i)).toBeNull();
  });

  it("express formu render edilir ve prompt yazilinca gunceller", () => {
    const onExpressPrompt = vi.fn();
    const onExpressCreate = vi.fn();
    render(
      <ProjectPicker
        {...base}
        expressPrompt="Hava durumu uygulamasi"
        onExpressPrompt={onExpressPrompt}
        onExpressCreate={onExpressCreate}
      />
    );
    expect(screen.getByText(/Tek Cümleyle Hızlı Başlat/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Uygulama açıklaması"), { target: { value: "Yeni aciklama" } });
    expect(onExpressPrompt).toHaveBeenCalledWith("Yeni aciklama");
  });

  it("express hizli baslat dugmesi bos promptta devre disidir, dolu olunca cagrilir", () => {
    const onExpressCreate = vi.fn();
    const { rerender } = render(
      <ProjectPicker
        {...base}
        expressPrompt=""
        onExpressPrompt={() => undefined}
        onExpressCreate={onExpressCreate}
      />
    );
    const btn = screen.getByRole("button", { name: /Hızlı Başlat/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <ProjectPicker
        {...base}
        expressPrompt="Bir chat botu"
        onExpressPrompt={() => undefined}
        onExpressCreate={onExpressCreate}
      />
    );
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    expect(onExpressCreate).toHaveBeenCalledTimes(1);
  });

  it("express inputunda Enter tusuna basilinca onExpressCreate tetiklenir", () => {
    const onExpressCreate = vi.fn();
    render(
      <ProjectPicker
        {...base}
        expressPrompt="Hizli test"
        onExpressPrompt={() => undefined}
        onExpressCreate={onExpressCreate}
      />
    );
    fireEvent.keyDown(screen.getByLabelText("Uygulama açıklaması"), { key: "Enter" });
    expect(onExpressCreate).toHaveBeenCalledTimes(1);
  });
});
