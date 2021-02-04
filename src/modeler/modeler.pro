# TODO: Simplify this file removing unnecessary INCLUDEPATH/HEADERS and so on
QT       += core gui widgets opengl

TARGET = modeler
TEMPLATE = app
CONFIG += console

INCLUDEPATH += $$PWD/modeler/ \
               $$PWD/../../third-party/

HEADERS  += \
    ca_modeler_gui.h \
    ModelPropertiesHandler/model_properties_handler_widget.h \
    ModelPropertiesHandler/model_attr_init_value.h \
    AttributeHandler/attribute_handler_widget.h \
    VicinityHandler/vicinity_handler_widget.h \
    UpdateRulesHandler/update_rules_handler.h \
    UpdateRulesHandler/update_rules_editor.h \
    UpdateRulesHandler/node_graph_instance.h \
    ColorMappingsHandler/color_mappings_handler_widget.h \
    model/ca_model.h \
    model/model_properties.h \
    model/attribute.h \
    model/neighborhood.h \
    model/mapping.h \
    $$PWD/../../third-party/imgui/imgui.h \
    $$PWD/../../third-party/imgui/imgui_impl_glfw.h \
    $$PWD/../../third-party/imgui/imconfig.h \
    $$PWD/../../third-party/imgui/imgui_internal.h \
    $$PWD/../../third-party/glfw/glfw3native.h \
    $$PWD/../../third-party/imgui/stb_textedit.h \
    $$PWD/../../third-party/imgui/stb_rect_pack.h \
    $$PWD/../../third-party/imgui/stb_truetype.h \
    $$PWD/../../third-party/nodes_editor/imguinodegrapheditor.h

SOURCES += \
  main.cpp \
  ca_modeler_gui.cpp \
  ModelPropertiesHandler/model_properties_handler_widget.cpp \
  ModelPropertiesHandler/model_attr_init_value.cpp \
  AttributeHandler/attribute_handler_widget.cpp \
  VicinityHandler/vicinity_handler_widget.cpp \
  UpdateRulesHandler/update_rules_handler.cpp \
  UpdateRulesHandler/update_rules_editor.cpp \
  ColorMappingsHandler/color_mappings_handler_widget.cpp \
  model/ca_model.cpp \
  $$PWD/../../third-party/imgui/imgui.cpp \
  $$PWD/../../third-party/imgui/imgui_impl_glfw.cpp \
  $$PWD/../../third-party/imgui/imgui_draw.cpp \
  $$PWD/../../third-party/nodes_editor/imguinodegrapheditor.cpp

FORMS    += \
    ca_modeler_gui.ui \
    ModelPropertiesHandler/model_properties_handler_widget.ui \
    ModelPropertiesHandler/model_attr_init_value.ui \
    AttributeHandler/attribute_handler_widget.ui \
    VicinityHandler/vicinity_handler_widget.ui \
    UpdateRulesHandler/update_rules_handler.ui \
    ColorMappingsHandler/color_mappings_handler_widget.ui

LIBS += -L"$$PWD/../../third-party/glfw/" -lglfw3 -lopengl32 -lgdi32

# Copies files necessary for compilation of generated c++ code produced by Genesis models.
CONFIG += file_copies
COPIES += simulator_files
simulator_files.files += $$files($$PWD/../simulator/main.cpp) # simulator main
simulator_files.files += $$files($$PWD/../simulator/bitmap_image.hpp) # bitmap exporter
CONFIG(debug, debug|release) {
  simulator_files.path = $$OUT_PWD/debug/StandaloneApplication
} else {
  simulator_files.path = $$OUT_PWD/release/StandaloneApplication
}

# imgui
COPIES += imgui
imgui.files = $$files($$PWD/../../third-party/imgui/*.h) # imgui .h
imgui.files += $$files($$PWD/../../third-party/imgui/*.cpp) # imgui .cpp
CONFIG(debug, debug|release) {
  imgui.path = $$OUT_PWD/debug/StandaloneApplication/imgui
} else {
  imgui.path = $$OUT_PWD/release/StandaloneApplication/imgui
}

# GlFW
COPIES += glfw
glfw.files += $$files($$PWD/../../third-party/glfw/*) # glfw
CONFIG(debug, debug|release) {
  glfw.path = $$OUT_PWD/debug/StandaloneApplication/glfw
} else {
  glfw.path = $$OUT_PWD/release/StandaloneApplication/glfw
}
