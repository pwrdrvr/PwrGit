/* Standalone APFS evidence probe. No Git internals or product dependencies.
 * First extent equality is a sharing signal, not proof about every extent.
 * Private size is queried independently; never add st_blocks across clones.
 */
#include <sys/attr.h>
#include <sys/fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    for (int i = 1; i < argc; i++) {
        int fd = open(argv[i], O_RDONLY | O_NOFOLLOW);
        struct log2phys physical = {0};
        physical.l2p_contigbytes = 1;
        long long block = -1, private_bytes = -1;
        struct attrlist attrs = {0};
        attrs.bitmapcount = ATTR_BIT_MAP_COUNT;
        attrs.forkattr = ATTR_CMNEXT_PRIVATESIZE;
        unsigned char buffer[32] = {0};
        if (fd >= 0) {
            if (!fcntl(fd, F_LOG2PHYS_EXT, &physical))
                block = physical.l2p_devoffset;
            if (!fgetattrlist(fd, &attrs, buffer, sizeof(buffer), FSOPT_ATTR_CMN_EXTENDED)) {
                uint64_t value;
                memcpy(&value, buffer + 4, sizeof(value));
                private_bytes = (long long)value;
            }
            close(fd);
        }
        printf("%lld\t%lld\t%s\n", block, private_bytes, argv[i]);
    }
    return 0;
}
