{
  description = "Emergency button bridge — dev shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            (pkgs.python313.withPackages (ps: [
              ps.httpx
              ps.paho-mqtt
              ps.python-dotenv
              ps.anyio
              # kiosk-ui backend (run `uvicorn --app-dir kiosk-ui/backend main:app` for local dev)
              ps.fastapi
              ps.uvicorn
            ]))
            # kiosk-ui frontend (Vite + React). npm install populates
            # kiosk-ui/frontend/package-lock.json — that lock is what
            # buildNpmPackage in ../app/kiosk-ui.nix reads.
            pkgs.nodejs_20
          ];
        };
      });
    };
}
