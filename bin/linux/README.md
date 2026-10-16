# Linux Axel

Release builds use `scripts/build-linux-axel.sh`: unmodified Axel 2.17.14,
static musl libc and OpenSSL 3.6.4. No distribution-specific libssl runtime is required.
Source URLs and verified SHA-256 values are in the build script.
The OpenSSL and Axel license texts accompany this binary.

The Linux Node runtime retains the existing glibc 2.17 compatible Node 20.18.3
runtime for HPC systems; build and upgrade tests exercise the shipped runtime.
