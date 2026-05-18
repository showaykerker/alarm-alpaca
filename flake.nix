{
  description = "alarm-alpaca — Raspberry Pi 5 emergency-button kiosk";

  nixConfig = {
    extra-substituters = [
      "https://nixos-raspberrypi.cachix.org"
    ];
    extra-trusted-public-keys = [
      "nixos-raspberrypi.cachix.org-1:4iMO9LXa8BqhU+Rpg6LQKiGa2lsNh/j2oiYLNOQ5sPI="
    ];
    connect-timeout = 5;
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

    nixos-raspberrypi = {
      url = "github:nvmd/nixos-raspberrypi/main";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    agenix = {
      url = "github:ryantm/agenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    deploy-rs = {
      url = "github:serokell/deploy-rs";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      ...
    }@inputs:
    let
      allSystems = nixpkgs.lib.systems.flakeExposed;
      forSystems = systems: f: nixpkgs.lib.genAttrs systems (system: f system);
    in
    {
      formatter = forSystems allSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);

      devShells = forSystems allSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            name = "alarm-alpaca";
            nativeBuildInputs = with pkgs; [
              nil
              nixfmt-tree
              nix-output-monitor
              bash-language-server
              shellcheck
              gh
            ];
            shellHook = ''
              # Route git hooks to the repo-tracked scripts/git-hooks/ so the
              # pre-commit guard against committing secrets/ is always active.
              if [ -d .git ] && [ "$(git config core.hooksPath)" != "scripts/git-hooks" ]; then
                git config core.hooksPath scripts/git-hooks
                echo "[shellHook] set core.hooksPath = scripts/git-hooks"
              fi
            '';
          };
        }
      );
    };
}
