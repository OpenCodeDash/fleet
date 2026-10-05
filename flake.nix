{
  description = "ephemeral agent fleet — nspawn + headless opencode control plane";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.nodejs_24 # orchestrator (opencode SDK is TS/JS)
          pkgs.git
          pkgs.opencode
        ];
        shellHook = ''
          echo "fleet dev shell"
          echo "  node:     $(node --version)"
          echo "  opencode: $(opencode --version 2>/dev/null || echo 'n/a')"
        '';
      };
    };
}
